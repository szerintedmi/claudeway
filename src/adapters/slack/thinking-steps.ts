import type { TaskUpdateChunk, RichTextBlock, Block } from '@slack/types';
import type { ToolEventPayload } from '../../core/interfaces.js';
import {
  formatToolTaskTitle,
  TASK_DETAILS_MAX,
  THINKING_TASK_TITLE,
  WORK_LOG_TITLE,
} from './formatting.js';

/** Total cap on folded details content (Slack hard-truncates around 8000). */
export const DETAILS_MAX_CHARS = 7000;
/** Per-section cap inside the details container (section text limit is 3000). */
const DETAILS_SECTION_MAX_CHARS = 2900;
/** Container blocks accept at most 10 child blocks. */
const CONTAINER_MAX_CHILDREN = 10;

/**
 * `container` block (GA 2026-06-29) — not yet in @slack/types 7.x, so declared
 * locally. Spike-verified: the API requires `title` as a plain_text object
 * (the docs' "string" is the text inside it).
 */
export interface ContainerBlock {
  type: 'container';
  title: { type: 'plain_text'; text: string; emoji?: boolean };
  is_collapsible?: boolean;
  default_collapsed?: boolean;
  /** Rendered width; default 'standard' looks boxed-in next to message text. */
  width?: 'narrow' | 'standard' | 'wide' | 'full';
  child_blocks: Block[];
}

/**
 * Build the collapsed "📋 Details" container for the folded detail section.
 * Content is capped and chunked into section blocks under the container's
 * child-block limit.
 */
export function buildDetailsContainer(details: string, title: string): ContainerBlock {
  const capped =
    details.length > DETAILS_MAX_CHARS
      ? `${details.slice(0, DETAILS_MAX_CHARS)}\n\n_…(truncated)_`
      : details;
  const children: Block[] = [];
  for (
    let i = 0;
    i < capped.length && children.length < CONTAINER_MAX_CHILDREN;
    i += DETAILS_SECTION_MAX_CHARS
  ) {
    children.push({
      type: 'section',
      text: { type: 'mrkdwn', text: capped.slice(i, i + DETAILS_SECTION_MAX_CHARS) },
    } as Block);
  }
  return {
    type: 'container',
    title: { type: 'plain_text', text: title, emoji: true },
    is_collapsible: true,
    default_collapsed: true,
    width: 'full',
    child_blocks: children,
  };
}

/** Truncate a task_update field to Slack's per-update cap, word-trimmed. */
function truncateField(text: string): string {
  if (text.length <= TASK_DETAILS_MAX) return text;
  return `${text.slice(0, TASK_DETAILS_MAX - 1)}…`;
}

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
  details?: string;
  output?: string;
}

/**
 * Pure state machine mapping Claude turn events (tool events, reasoning deltas)
 * to Slack `task_update` chunks, and remembering every card so a broken stream
 * can be rebuilt as blocks. No I/O — the responder forwards returned chunks to
 * the stream.
 */
export class TaskTracker {
  /** Every card ever created, in creation order (rebuild source of truth). */
  private tasks: TrackedTask[] = [];
  private byId = new Map<string, TrackedTask>();
  /** Open (in_progress) tool cards, innermost last — completed LIFO by toolName. */
  private openTools: TrackedTask[] = [];
  /** The open rolling reasoning card, if a burst is in flight. */
  private thinking: TrackedTask | null = null;
  private thinkingBurst = '';
  private nextId = 0;

  private create(toolName: string, title: string, status: TaskUpdateChunk['status']): TrackedTask {
    const task: TrackedTask = { id: `t${this.nextId++}`, toolName, title, status };
    this.tasks.push(task);
    this.byId.set(task.id, task);
    return task;
  }

  private toChunk(task: TrackedTask): TaskUpdateChunk {
    return {
      type: 'task_update',
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.details ? { details: task.details } : {}),
      ...(task.output ? { output: task.output } : {}),
    };
  }

  /** Map a tool event to chunk(s). Returns [] for phases with nothing to show. */
  onToolEvent(event: ToolEventPayload): TaskUpdateChunk[] {
    const chunks: TaskUpdateChunk[] = [];
    const boundary = this.boundary();
    if (boundary) chunks.push(boundary);

    if (event.phase === 'start') {
      const task = this.create(
        event.toolName,
        formatToolTaskTitle(event.toolName, null),
        'in_progress',
      );
      this.openTools.push(task);
      chunks.push(this.toChunk(task));
    } else if (event.phase === 'complete') {
      // Match the innermost open card for this tool (LIFO); tolerate a missing
      // 'start' by creating the card directly in its final state.
      let task: TrackedTask | undefined;
      for (let i = this.openTools.length - 1; i >= 0; i--) {
        if (this.openTools[i].toolName === event.toolName) {
          task = this.openTools.splice(i, 1)[0];
          break;
        }
      }
      if (!task) task = this.create(event.toolName, '', 'complete');
      task.title = formatToolTaskTitle(event.toolName, event.keyArg ?? null);
      task.status = 'complete';
      chunks.push(this.toChunk(task));
    } else if (event.phase === 'subagent_progress' || event.phase === 'subagent_completed') {
      // Attach subagent activity to the innermost open Task/Agent card; when
      // none is open (shouldn't happen), fall back to a standalone card.
      let task = [...this.openTools]
        .reverse()
        .find((t) => t.toolName === 'Task' || t.toolName === 'Agent');
      if (!task) {
        task = this.create(
          event.toolName,
          formatToolTaskTitle(event.toolName, null),
          'in_progress',
        );
        this.openTools.push(task);
      }
      if (event.phase === 'subagent_progress') {
        task.details = truncateField(event.description ?? '');
      } else {
        task.output = truncateField(event.description ?? '');
      }
      chunks.push(this.toChunk(task));
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
    }
    return this.toChunk(this.thinking);
  }

  /**
   * Feed a reasoning delta into the rolling "Thinking" card. Returns the chunk
   * to send, or null when the visible tail hasn't changed.
   */
  onReasoningDelta(text: string): TaskUpdateChunk | null {
    if (text.length === 0) return null;
    if (!this.thinking) {
      this.thinking = this.create('__thinking__', THINKING_TASK_TITLE, 'in_progress');
      this.thinkingBurst = '';
    }
    this.thinkingBurst += text;
    const details = rollingTail(this.thinkingBurst);
    if (details === this.thinking.details) return null;
    this.thinking.details = details;
    return this.toChunk(this.thinking);
  }

  /** A non-reasoning event: complete any open Thinking card. */
  boundary(): TaskUpdateChunk | null {
    if (!this.thinking) return null;
    const task = this.thinking;
    this.thinking = null;
    task.status = 'complete';
    return this.toChunk(task);
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
    for (const task of this.openTools) {
      task.status = status;
      chunks.push(this.toChunk(task));
    }
    this.openTools = [];
    if (status === 'error' && errorMessage) {
      const task = this.create('__error__', 'Error', 'error');
      task.details = truncateField(errorMessage);
      chunks.push(this.toChunk(task));
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
 * Streaming gate that keeps the `-- DETAILS --` marker and everything after it
 * off the wire. Feed text deltas through {@link push}; it returns the prefix
 * that is safe to display. Fence-parity aware: a marker inside a ``` code block
 * is content, not a fold directive (matches `splitDetails` semantics).
 */
export class DetailsGate {
  /** Completed-line scan buffer (text released is removed from it). */
  private partial = '';
  private inFence = false;
  private markerFound = false;
  private detailsText = '';
  private visibleEmitted = 0;

  /** Feed a delta; returns the text safe to stream now (possibly ''). */
  push(text: string): string {
    if (text.length === 0) return '';
    if (this.markerFound) {
      this.detailsText += text;
      return '';
    }
    this.partial += text;
    let out = '';
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
        this.detailsText = this.partial;
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
    return out;
  }

  /**
   * End of stream: resolve any held text. Mirrors `splitDetails` edge cases —
   * an empty details section is no details; a marker with no body before it
   * promotes the details to the visible tail.
   */
  finish(): { tail: string; details: string | null } {
    if (!this.markerFound) {
      // Any held partial line was never disambiguated — it is visible content
      // (a lone "--" line, trailing whitespace, etc.).
      const tail = this.partial;
      this.partial = '';
      return { tail, details: null };
    }
    const details = this.detailsText.trim();
    if (!details) return { tail: '', details: null };
    if (this.visibleEmitted === 0) return { tail: details, details: null };
    return { tail: '', details };
  }

  get sawMarker(): boolean {
    return this.markerFound;
  }
}
