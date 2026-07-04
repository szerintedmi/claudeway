import type { TaskUpdateChunk, RichTextBlock, Block } from '@slack/types';
import type { ToolEventPayload } from '../../core/interfaces.js';
import {
  formatToolTaskTitle,
  DETAILS_INLINE_HEADER,
  TASK_DETAILS_MAX,
  TASK_TITLE_MAX,
  THINKING_TASK_TITLE,
  WORK_LOG_TITLE,
} from './formatting.js';

/** Truncate a task_update field to Slack's per-update cap, word-trimmed. */
function truncateField(text: string): string {
  if (text.length <= TASK_DETAILS_MAX) return text;
  return `${text.slice(0, TASK_DETAILS_MAX - 1)}…`;
}

/**
 * Cap on the details text STORED per card for the rebuild path (the rendered
 * task_card block). Live emission is delta-based and separately capped.
 */
const STORED_DETAILS_MAX = 750;

/**
 * Cap on the reasoning text streamed live into a Thinking card's details.
 * Spike-verified (2026-07-03): `details` on task_update chunks is APPEND-only
 * (like markdown_text) — every re-send concatenates, so the rolling-tail
 * re-send pattern duplicates text. Live emission therefore appends deltas and
 * stops at this cap; the stored card keeps a rolling tail for rebuilds.
 */
const THINKING_LIVE_MAX_CHARS = 500;

/** Rolling tail of a reasoning burst: last ~TASK_DETAILS_MAX chars, word-aligned. */
function rollingTail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TASK_DETAILS_MAX) return flat;
  let tail = flat.slice(-(TASK_DETAILS_MAX - 1));
  const firstSpace = tail.indexOf(' ');
  if (firstSpace > 0 && firstSpace < 40) tail = tail.slice(firstSpace + 1);
  return `…${tail}`;
}

interface TrackedTask {
  id: string;
  toolName: string;
  title: string;
  status: TaskUpdateChunk['status'];
  /** Accumulated details for the REBUILD path (capped); live chunks carry deltas. */
  details?: string;
  output?: string;
}

/** Per-chunk field deltas — `details`/`output` APPEND on Slack's side. */
interface FieldDeltas {
  details?: string;
  output?: string;
}

interface OpenTool {
  toolName: string;
  /** Stream content-block index — the stable key a completion is matched on
   *  (undefined only for synthetic subagent cards / index-less legacy events). */
  index: number | undefined;
  /** Card receiving this tool's updates: its own card, or the enclosing step. */
  task: TrackedTask;
  /** True when `task` is a step card (the tool renders as its details line). */
  inStep: boolean;
}

/**
 * Pure state machine mapping Claude turn events (tool events, reasoning deltas,
 * demoted narration runs) to Slack `task_update` chunks, and remembering every
 * card so a broken stream can be rebuilt as blocks. No I/O — the responder
 * forwards returned chunks to the stream.
 *
 * Card model: each narration run opens a "step" card (bold title = what the
 * model said it was doing). Tool calls under an open step don't get their own
 * cards — they append to the step's `details` log (lighter secondary text),
 * as do subagent progress (`details`) and completion (`output`). Tools
 * arriving before any narration keep standalone cards.
 *
 * Wire semantics (spike-verified 2026-07-03): `title` and `status` REPLACE on
 * re-send, but `details`/`output` APPEND — including identical re-sends. So
 * emitted chunks carry only field DELTAS (never accumulated state), and a
 * capped accumulated copy is kept per card for the blocks rebuild.
 */
export class TaskTracker {
  /** Every card ever created, in creation order (rebuild source of truth). */
  private tasks: TrackedTask[] = [];
  private byId = new Map<string, TrackedTask>();
  /** Open tool calls, innermost last — completed LIFO by toolName. */
  private openTools: OpenTool[] = [];
  /** The step card collecting tool activity, until the next narration/answer. */
  private activeStep: TrackedTask | null = null;
  /** The open rolling reasoning card, if a burst is in flight. */
  private thinking: TrackedTask | null = null;
  private thinkingBurst = '';
  /** Chars of the current burst already emitted live (append-only budget). */
  private thinkingSent = 0;
  private nextId = 0;

  private create(toolName: string, title: string, status: TaskUpdateChunk['status']): TrackedTask {
    const task: TrackedTask = { id: `t${this.nextId++}`, toolName, title, status };
    this.tasks.push(task);
    this.byId.set(task.id, task);
    return task;
  }

  /**
   * Build the wire chunk for a card. `details`/`output` append server-side, so
   * they are included ONLY as explicit deltas — never from accumulated state.
   */
  private toChunk(task: TrackedTask, deltas: FieldDeltas = {}): TaskUpdateChunk {
    return {
      type: 'task_update',
      id: task.id,
      title: task.title,
      status: task.status,
      ...(deltas.details ? { details: deltas.details } : {}),
      ...(deltas.output ? { output: deltas.output } : {}),
    };
  }

  /** Append a delta to the card's stored details (rebuild view), capped. */
  private storeDetails(task: TrackedTask, delta: string): void {
    const joined = (task.details ?? '') + delta;
    task.details =
      joined.length > STORED_DETAILS_MAX ? `…${joined.slice(-STORED_DETAILS_MAX)}` : joined;
  }

  /** Map a tool event to chunk(s). Returns [] for phases with nothing to show. */
  onToolEvent(event: ToolEventPayload): TaskUpdateChunk[] {
    const chunks: TaskUpdateChunk[] = [];
    const boundary = this.boundary();
    if (boundary) chunks.push(boundary);

    if (event.phase === 'start') {
      if (this.activeStep) {
        // Step-bound tools show up as a completed-line log entry; a 'start'
        // alone adds no information (the step spinner already shows activity)
        // and every details send appends, so emit nothing yet.
        this.openTools.push({
          toolName: event.toolName,
          index: event.index,
          task: this.activeStep,
          inStep: true,
        });
      } else {
        const task = this.create(
          event.toolName,
          formatToolTaskTitle(event.toolName, null),
          'in_progress',
        );
        this.openTools.push({
          toolName: event.toolName,
          index: event.index,
          task,
          inStep: false,
        });
        chunks.push(this.toChunk(task));
      }
    } else if (event.phase === 'complete') {
      // Match the open call by its stream content-block index — a stable key, so
      // parallel same-name calls finishing out of order label the right card.
      // Fall back to the innermost same-name call (LIFO), then tolerate a missing
      // 'start' by attaching to the step (or a fresh card) in its final state.
      let entry: OpenTool | undefined;
      let idx =
        event.index !== undefined ? this.openTools.findIndex((t) => t.index === event.index) : -1;
      if (idx === -1) {
        for (let i = this.openTools.length - 1; i >= 0; i--) {
          if (this.openTools[i].toolName === event.toolName) {
            idx = i;
            break;
          }
        }
      }
      if (idx !== -1) {
        entry = this.openTools.splice(idx, 1)[0];
      }
      const title = formatToolTaskTitle(event.toolName, event.keyArg ?? null);
      if (entry ? entry.inStep : this.activeStep !== null) {
        const step = entry ? entry.task : this.activeStep!;
        const delta = `${truncateField(title)}\n`;
        this.storeDetails(step, delta);
        chunks.push(this.toChunk(step, { details: delta }));
      } else {
        const task = entry?.task ?? this.create(event.toolName, '', 'complete');
        task.title = title;
        task.status = 'complete';
        chunks.push(this.toChunk(task));
      }
    } else if (event.phase === 'subagent_progress' || event.phase === 'subagent_completed') {
      // Attach subagent activity to the innermost open Task/Agent call (its own
      // card or the enclosing step); fall back to the active step, then to a
      // standalone card.
      let task = [...this.openTools]
        .reverse()
        .find((t) => t.toolName === 'Task' || t.toolName === 'Agent')?.task;
      if (!task && this.activeStep) task = this.activeStep;
      if (!task) {
        task = this.create(
          event.toolName,
          formatToolTaskTitle(event.toolName, null),
          'in_progress',
        );
        // Subagent events carry no content-block index; leaving it undefined
        // means this card is only ever matched by name (Task/Agent).
        this.openTools.push({ toolName: event.toolName, index: undefined, task, inStep: false });
      }
      if (event.phase === 'subagent_progress') {
        const delta = `${truncateField(event.description ?? '')}\n`;
        this.storeDetails(task, delta);
        chunks.push(this.toChunk(task, { details: delta }));
      } else {
        const delta = truncateField(event.description ?? '');
        task.output = delta;
        chunks.push(this.toChunk(task, { output: delta }));
      }
    }
    return chunks;
  }

  /**
   * Create the initial "Thinking" card the stream opens with — it doubles as
   * the instant-feedback placeholder and becomes the first reasoning burst's
   * card (completed at the first non-reasoning boundary).
   */
  seed(): TaskUpdateChunk {
    if (!this.thinking) {
      this.thinking = this.create('__thinking__', THINKING_TASK_TITLE, 'in_progress');
      this.thinkingBurst = '';
      this.thinkingSent = 0;
    }
    return this.toChunk(this.thinking);
  }

  /**
   * Feed a reasoning delta into the "Thinking" card. Live details append
   * server-side, so each chunk carries only the new text, stopping (with a
   * final ellipsis) at {@link THINKING_LIVE_MAX_CHARS}; the stored card keeps
   * a rolling tail of the whole burst for the rebuild view. Returns the chunk
   * to send, or null when there is nothing left to emit live.
   */
  onReasoningDelta(text: string): TaskUpdateChunk | null {
    if (text.length === 0) return null;
    if (!this.thinking) {
      this.thinking = this.create('__thinking__', THINKING_TASK_TITLE, 'in_progress');
      this.thinkingBurst = '';
      this.thinkingSent = 0;
    }
    this.thinkingBurst += text;
    this.thinking.details = rollingTail(this.thinkingBurst);
    if (this.thinkingSent >= THINKING_LIVE_MAX_CHARS) return null;
    let delta = text;
    if (this.thinkingSent + delta.length > THINKING_LIVE_MAX_CHARS) {
      delta = `${delta.slice(0, THINKING_LIVE_MAX_CHARS - this.thinkingSent)}…`;
      this.thinkingSent = THINKING_LIVE_MAX_CHARS;
    } else {
      this.thinkingSent += delta.length;
    }
    return this.toChunk(this.thinking, { details: delta });
  }

  /**
   * A demoted narration run (assistant text that turned out to precede another
   * tool/reasoning event, not the final answer) opens a new step card: the
   * flattened text becomes the bold title, and subsequent tool activity rolls
   * through its details line. Closes any open Thinking card and completes the
   * previous step first.
   */
  narration(text: string): TaskUpdateChunk[] {
    const chunks: TaskUpdateChunk[] = [];
    const boundary = this.boundary();
    if (boundary) chunks.push(boundary);
    const done = this.completeStep('complete');
    if (done) chunks.push(done);
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) return chunks;
    const step = this.create('__step__', flat, 'in_progress');
    if (flat.length > TASK_TITLE_MAX) {
      step.title = `${flat.slice(0, TASK_TITLE_MAX - 1)}…`;
    }
    this.activeStep = step;
    chunks.push(this.toChunk(step));
    return chunks;
  }

  /** A non-reasoning event: complete any open Thinking card. */
  boundary(): TaskUpdateChunk | null {
    if (!this.thinking) return null;
    const task = this.thinking;
    this.thinking = null;
    task.status = 'complete';
    return this.toChunk(task);
  }

  /** Close the active step (its tool calls are done with it). */
  private completeStep(status: 'complete' | 'error'): TaskUpdateChunk | null {
    if (!this.activeStep) return null;
    const step = this.activeStep;
    this.activeStep = null;
    this.openTools = this.openTools.filter((t) => t.task !== step);
    step.status = status;
    return this.toChunk(step);
  }

  /**
   * The answer started streaming: close the Thinking card and the active step
   * so nothing spins while the final text renders.
   */
  answerBoundary(): TaskUpdateChunk[] {
    const chunks: TaskUpdateChunk[] = [];
    const boundary = this.boundary();
    if (boundary) chunks.push(boundary);
    const done = this.completeStep('complete');
    if (done) chunks.push(done);
    return chunks;
  }

  /**
   * Close every open card at end of turn. On failure the open cards flip to
   * `error` and a synthetic Error card carries the (truncated) message.
   */
  closeAll(status: 'complete' | 'error', errorMessage?: string): TaskUpdateChunk[] {
    const chunks: TaskUpdateChunk[] = [];
    const boundary = this.boundary();
    if (boundary) {
      if (status === 'error') {
        const task = this.byId.get(boundary.id)!;
        task.status = 'error';
        chunks.push(this.toChunk(task));
      } else {
        chunks.push(boundary);
      }
    }
    const step = this.completeStep(status);
    if (step) chunks.push(step);
    for (const entry of this.openTools) {
      entry.task.status = status;
      chunks.push(this.toChunk(entry.task));
    }
    this.openTools = [];
    if (status === 'error' && errorMessage) {
      const task = this.create('__error__', 'Error', 'error');
      const delta = truncateField(errorMessage);
      task.details = delta;
      chunks.push(this.toChunk(task, { details: delta }));
    }
    return chunks;
  }

  hasTasks(): boolean {
    return this.tasks.length > 0;
  }

  /**
   * Rebuild the whole work log as blocks (for the broken-stream `chat.update`
   * path): one plan block holding every card in creation order.
   */
  toBlocks(): Block[] {
    if (this.tasks.length === 0) return [];
    const rich = (text: string): RichTextBlock => ({
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
    });
    return [
      {
        type: 'plan',
        title: WORK_LOG_TITLE,
        tasks: this.tasks.map((t) => ({
          type: 'task_card',
          task_id: t.id,
          title: t.title || t.toolName,
          status: t.status,
          ...(t.details ? { details: rich(t.details) } : {}),
          ...(t.output ? { output: rich(t.output) } : {}),
        })),
      } as unknown as Block,
    ];
  }
}

/** A full marker line: `-- DETAILS --` (2+ dashes each side, case-insensitive). */
const MARKER_LINE = /^[ \t]*-{2,}[ \t]*DETAILS[ \t]*-{2,}[ \t]*$/i;

/**
 * True when a trailing partial line could still grow into a marker line, so it
 * must be withheld until its newline arrives: nothing but whitespace/dashes so
 * far, or a line opening with 2+ dashes (disambiguated at line end). A plain
 * list item ("- foo") fails both tests and streams immediately.
 */
function couldBecomeMarker(partialLine: string): boolean {
  return /^[ \t-]*$/.test(partialLine) || /^[ \t]*-{2,}/.test(partialLine);
}

/**
 * Streaming transform that rewrites the `-- DETAILS --` marker line into the
 * inline {@link DETAILS_INLINE_HEADER} and lets everything after it keep
 * streaming. Feed text deltas through {@link push}; it returns the text safe
 * to display. Fence-parity aware: a marker inside a ``` code block is content,
 * not a section break (matches `splitDetails` semantics). The header is
 * withheld until the details section proves non-empty (an empty section never
 * shows a dangling header), and skipped when nothing visible precedes the
 * marker (the details then stream as the body — mirrors the `splitDetails`
 * promotion).
 */
export class DetailsGate {
  /** Completed-line scan buffer (text released is removed from it). */
  private partial = '';
  private inFence = false;
  private markerFound = false;
  /** Post-marker text held until the section proves non-empty. */
  private held = '';
  private headerEmitted = false;
  private visibleEmitted = 0;

  /** Feed a delta; returns the text safe to stream now (possibly ''). */
  push(text: string): string {
    if (text.length === 0) return '';
    if (this.markerFound && this.headerEmitted) return text;
    let out = '';
    if (this.markerFound) {
      this.held += text;
    } else {
      this.partial += text;
      // Release complete lines, scanning each for fences and the marker.
      let nl: number;
      while (!this.markerFound && (nl = this.partial.indexOf('\n')) !== -1) {
        const line = this.partial.slice(0, nl);
        this.partial = this.partial.slice(nl + 1);
        if (/^```/.test(line)) {
          this.inFence = !this.inFence;
          out += line + '\n';
        } else if (!this.inFence && MARKER_LINE.test(line)) {
          this.markerFound = true;
          this.held = this.partial;
          this.partial = '';
        } else {
          out += line + '\n';
        }
      }
      // Release the trailing partial line unless it could still become a marker.
      if (
        !this.markerFound &&
        this.partial.length > 0 &&
        (this.inFence || !couldBecomeMarker(this.partial))
      ) {
        out += this.partial;
        this.partial = '';
      }
      this.visibleEmitted += out.length;
    }
    // The details section has content: release it, prefixed with the header
    // (unless nothing visible preceded the marker — then details ARE the body).
    if (this.markerFound && !this.headerEmitted && this.held.trim().length > 0) {
      this.headerEmitted = true;
      out += (this.visibleEmitted > 0 ? DETAILS_INLINE_HEADER : '') + this.held;
      this.held = '';
    }
    return out;
  }

  /**
   * End of stream: resolve any held text. A pre-marker partial line that was
   * never disambiguated is visible content (a lone "--" line, trailing
   * whitespace); a marker whose section stayed empty is dropped entirely.
   */
  finish(): { tail: string } {
    if (this.markerFound) return { tail: '' };
    const tail = this.partial;
    this.partial = '';
    return { tail };
  }
}
