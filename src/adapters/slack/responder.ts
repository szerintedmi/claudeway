import { basename } from 'path';
import type { WebClient } from '@slack/web-api';
import type {
  ChannelResponder,
  IStreamingResponder,
  ToolEventPayload,
} from '../../core/interfaces.js';
import type { ResponseMode } from '../../config.js';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  formatToolStatus,
  formatToolNote,
  MAX_MESSAGE_LENGTH,
  FILE_THRESHOLD,
  STREAM_UPDATE_INTERVAL_MS,
  STREAMING_INDICATOR,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
  STREAM_LIVE_NOTES_PREFIX,
  WORKING_NOTES_TITLE,
  STREAM_NATIVE_APPEND_RATE_PER_MIN,
  STREAM_NATIVE_APPEND_BURST,
} from './formatting.js';
import { safeReact, warnInThread } from './utils.js';

/** Map file extensions to Slack snippet_type values for inline preview. */
const SNIPPET_TYPE_MAP: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  csv: 'csv',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  js: 'javascript',
  ts: 'javascript',
  py: 'python',
  sh: 'shell',
  log: 'text',
  toml: 'toml',
  ini: 'text',
  sql: 'sql',
};

export function getSnippetType(filename: string): string | undefined {
  const ext = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  return ext ? SNIPPET_TYPE_MAP[ext] : undefined;
}

/**
 * Cap on working-notes attachment text. Slack hard-truncates attachment `text`
 * around 8000 chars; stay under so the "…(truncated)" marker is what shows for
 * oversized notes rather than an abrupt Slack cutoff.
 */
const WORKING_NOTES_MAX_CHARS = 7000;

/** Drop invisible keepalive tokens injected to keep an idle stream alive. */
function stripStreamArtifacts(text: string): string {
  return text.split(STREAM_KEEPALIVE_TOKEN).join('');
}

/**
 * Slack errors that mean the stream is permanently gone (no further appends or
 * stop will ever succeed). Anything else — rate limits, network blips, 5xx — is
 * treated as transient: we keep the stream open and retry rather than tearing
 * it down and triggering the full-text fallback.
 */
const STREAM_CLOSED_ERROR_CODES = new Set(['message_not_in_streaming_state', 'stopped_by_user']);

function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | undefined)?.data?.error;
}

function isStreamClosedError(err: unknown): boolean {
  const code = slackErrorCode(err);
  return code != null && STREAM_CLOSED_ERROR_CODES.has(code);
}

/**
 * Shared token bucket for `chat.appendStream` across every active stream.
 * appendStream is Tier 4 (100+/min) and the budget is per workspace token, not
 * per message — so all NativeStreamingResponder instances draw from this one
 * bucket. Callers check `tryConsumeAppendToken()` before appending; when it
 * returns false they defer to their next flush tick instead of calling the API.
 */
const appendBucket = { tokens: STREAM_NATIVE_APPEND_BURST, lastRefillMs: 0 };

function tryConsumeAppendToken(nowMs: number): boolean {
  if (appendBucket.lastRefillMs === 0) appendBucket.lastRefillMs = nowMs;
  const elapsed = nowMs - appendBucket.lastRefillMs;
  if (elapsed > 0) {
    appendBucket.tokens = Math.min(
      STREAM_NATIVE_APPEND_BURST,
      appendBucket.tokens + (elapsed / 60_000) * STREAM_NATIVE_APPEND_RATE_PER_MIN,
    );
    appendBucket.lastRefillMs = nowMs;
  }
  if (appendBucket.tokens >= 1) {
    appendBucket.tokens -= 1;
    return true;
  }
  return false;
}

/** Test-only: reset the shared appendStream rate limiter between cases. */
export function __resetAppendRateLimiterForTest(): void {
  appendBucket.tokens = STREAM_NATIVE_APPEND_BURST;
  appendBucket.lastRefillMs = 0;
}

class StreamingResponder implements IStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private messageTs: string | null = null;
  private fullText = '';
  private lastUpdateLen = 0;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private statusTs: string | null = null;

  constructor(client: WebClient, channel: string, threadTs: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    // Start the throttled update loop on first chunk
    if (!this.updateTimer && !this.finished) {
      this.updateTimer = setInterval(() => this.flush(), STREAM_UPDATE_INTERVAL_MS);
      // Post the initial message immediately
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.fullText.length === 0) return;
    // Skip if no new text — unless finished, where we must update to remove the indicator
    if (!this.finished && this.fullText.length === this.lastUpdateLen) return;

    const displayText = markdownToSlackMrkdwn(this.fullText);
    // Truncate for Slack's single-message limit, append indicator if still streaming
    const truncated =
      displayText.length > MAX_MESSAGE_LENGTH
        ? displayText.substring(0, MAX_MESSAGE_LENGTH - 20) + '\n_[streaming...]_'
        : displayText;
    const withIndicator = this.finished ? truncated : truncated + STREAMING_INDICATOR;

    try {
      if (!this.messageTs) {
        const res = await this.client.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: withIndicator,
        });
        this.messageTs = res.ts ?? null;
      } else {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.messageTs,
          text: withIndicator,
        });
      }
      this.lastUpdateLen = this.fullText.length;
    } catch (err) {
      console.error(`[streaming] Failed to update message:`, err);
    }
  }

  onToolEvent(event: ToolEventPayload): void {
    const text = formatToolStatus(event.toolName, event.phase === 'complete' ? event.keyArg : null);
    if (!this.statusTs) {
      this.client.chat
        .postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text,
        })
        .then((res) => {
          this.statusTs = res.ts ?? null;
        })
        .catch(() => {});
    } else {
      this.client.chat
        .update({
          channel: this.channel,
          ts: this.statusTs,
          text,
        })
        .catch(() => {});
    }
  }

  async finish(): Promise<void> {
    this.finished = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    // Final update to remove the streaming indicator
    if (this.fullText.length > 0) {
      await this.flush();
    }
    // Delete the status message
    if (this.statusTs) {
      try {
        await this.client.chat.delete({ channel: this.channel, ts: this.statusTs });
      } catch {
        // Best effort
      }
      this.statusTs = null;
    }
  }

  getFullText(): string {
    return this.fullText;
  }

  getMessageTs(): string | null {
    return this.messageTs;
  }
}

/**
 * One native Slack streaming message (`chat.startStream` → `appendStream` →
 * `stopStream`), with timer-batched flushing, idle keepalives, and resilience to
 * Slack finalizing the stream out from under us. Used twice by
 * {@link NativeStreamingResponder}: once for the live "working notes" and once
 * for the answer.
 */
class SlackTextStream {
  private streamTs: string | null = null;
  private streamBroken = false;
  /** Single source of truth for un-acked text — cleared only after a successful send. */
  private pending = '';
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastWriteAt = 0;
  private flushing = false;
  private currentFlush: Promise<void> = Promise.resolve();
  private started = false;
  private finished = false;

  constructor(
    private client: WebClient,
    private channel: string,
    private threadTs: string,
    private options: {
      recipientTeamId?: string;
      recipientUserId?: string;
      /** Fixed prefix prepended once to the very first chunk (cosmetic; not tracked). */
      prefix?: string;
      /** Called once, when startStream first returns a ts. */
      onStart?: () => void;
    } = {},
  ) {}

  /** Queue text for the stream; opens it (startStream) on the first call. */
  write(text: string): void {
    if (this.streamBroken || this.finished || text.length === 0) return;
    this.pending += text;
    if (!this.started) {
      this.started = true;
      this.lastWriteAt = Date.now();
      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => this.onFlushTick(), STREAM_NATIVE_FLUSH_INTERVAL_MS);
      }
      // Flush the first chunk immediately so the message appears without waiting
      // a full interval; later deltas are batched by the timer.
      this.kickFlush(false);
    }
  }

  private stopFlushLoop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private onFlushTick(): void {
    if (this.streamBroken || this.finished) {
      this.stopFlushLoop();
      return;
    }
    if (this.flushing) return;
    const now = Date.now();
    const wantKeepalive =
      this.pending.length === 0 && now - this.lastWriteAt >= STREAM_NATIVE_KEEPALIVE_MS;
    if (this.pending.length === 0 && !wantKeepalive) return;
    if (!tryConsumeAppendToken(now)) return;
    this.kickFlush(wantKeepalive);
  }

  private kickFlush(keepalive: boolean): void {
    this.flushing = true;
    this.currentFlush = this.flushPending(keepalive).finally(() => {
      this.flushing = false;
    });
  }

  private async flushPending(keepalive: boolean): Promise<void> {
    if (this.streamBroken) return;
    const text = this.pending; // cleared only on success
    if (!text && !keepalive) return;
    const toSend = text.length > 0 ? text : STREAM_KEEPALIVE_TOKEN;
    try {
      if (this.streamTs === null) {
        const res = await this.client.chat.startStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          markdown_text: (this.options.prefix ?? '') + toSend,
          ...(this.options.recipientTeamId
            ? { recipient_team_id: this.options.recipientTeamId }
            : {}),
          ...(this.options.recipientUserId
            ? { recipient_user_id: this.options.recipientUserId }
            : {}),
        });
        if (!res?.ts) {
          this.streamBroken = true;
          this.stopFlushLoop();
          console.error('[native-stream] startStream returned no ts');
          return;
        }
        this.streamTs = res.ts;
        this.options.onStart?.();
      } else {
        await this.client.chat.appendStream({
          channel: this.channel,
          ts: this.streamTs,
          markdown_text: toSend,
        });
      }
      if (text.length > 0) this.pending = this.pending.slice(text.length);
      this.lastWriteAt = Date.now();
    } catch (err) {
      const code = slackErrorCode(err);
      if (isStreamClosedError(err)) {
        this.streamBroken = true;
        this.stopFlushLoop();
        console.error('[native-stream] stream finalized early:', code);
      } else {
        console.error('[native-stream] append failed, will retry:', code ?? err);
      }
    }
  }

  /** Finalize the stream (stopStream with any tail). Idempotent. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopFlushLoop();
    await this.currentFlush.catch(() => {});
    if (this.streamTs !== null && !this.streamBroken) {
      const tail = this.pending;
      this.pending = '';
      try {
        await this.client.chat.stopStream({
          channel: this.channel,
          ts: this.streamTs,
          ...(tail ? { markdown_text: tail } : {}),
        });
      } catch (err) {
        this.streamBroken = true;
        console.error('[native-stream] failed to stop stream:', slackErrorCode(err) ?? err);
      }
    }
  }

  get ts(): string | null {
    return this.streamTs;
  }

  /** True only if the stream message exists and was not finalized early by Slack. */
  get deliveredOk(): boolean {
    return this.streamTs !== null && !this.streamBroken;
  }
}

/**
 * Drives two native Slack streams for one Claude turn:
 *
 * - a **working-notes** stream (extended-thinking reasoning + tool steps +
 *   inter-tool narration), shown live and collapsed into an attachment on
 *   completion; and
 * - an **answer** stream (the final response text), shown live and kept.
 *
 * Narration vs answer is decided by event ordering — a run of answer text that
 * is later followed by a tool/reasoning event was actually narration, so it is
 * appended to the notes and the answer is rebuilt verbatim from `result.text` on
 * completion. The final text run (nothing after it) is the answer. No
 * string-diffing of the answer back out of the live text is needed.
 *
 * When working-notes collapsing is disabled, the notes stream is never created:
 * reasoning is dropped, narration stays inline in the answer, and tool steps
 * surface as a single self-replacing status message (legacy behaviour).
 */
class NativeStreamingResponder implements IStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientTeamId?: string;
  private recipientUserId?: string;

  private readonly answer: SlackTextStream;
  private notes: SlackTextStream | null = null;
  private readonly collapse: boolean;

  /** Accumulated answer text (text deltas) — engine fallback when `result` is empty. */
  private answerText = '';
  /** Accumulated notes content, byte-identical to what was streamed to `notes`. */
  private notesText = '';
  /** Kind of the last note segment — drives separator choice in {@link writeNote}. */
  private lastNoteKind: 'reasoning' | 'tool' | 'narration' | 'none' = 'none';
  /**
   * Answer text streamed since the last tool/reasoning boundary. If a boundary
   * follows, this run was narration (flushed to notes, answer marked dirty); the
   * final run is the answer.
   */
  private pendingTextRun = '';
  /** Set once any text run is reclassified as narration — the live answer is then "dirty". */
  private answerDirty = false;
  private finished = false;

  /** Placeholder posted immediately for instant feedback; removed once a stream opens. */
  private placeholderPromise: Promise<string | null>;
  private placeholderTs: string | null = null;
  private placeholderResolved = false;
  private placeholderDeleted = false;
  /** Serializes status-message edits in the no-collapse path. */
  private statusChain: Promise<void> = Promise.resolve();
  private statusTs: string | null = null;
  /** No-collapse path: true once the status line took over the placeholder bubble. */
  private statusAdoptedPlaceholder = false;

  constructor(
    client: WebClient,
    channel: string,
    threadTs: string,
    options: {
      recipientTeamId?: string;
      recipientUserId?: string;
      collapseWorkingNotes: boolean;
    },
  ) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
    this.recipientTeamId = options.recipientTeamId;
    this.recipientUserId = options.recipientUserId;
    this.collapse = options.collapseWorkingNotes;

    this.answer = new SlackTextStream(client, channel, threadTs, {
      recipientTeamId: options.recipientTeamId,
      recipientUserId: options.recipientUserId,
      onStart: () => this.removePlaceholder(),
    });

    this.placeholderPromise = client.chat
      .postMessage({ channel, thread_ts: threadTs, text: ':thinking_face: _thinking..._' })
      .then((res) => {
        this.placeholderResolved = true;
        this.placeholderTs = res.ts ?? null;
        // A removal may have been requested before the post resolved.
        if (this.placeholderDeleted && this.placeholderTs) {
          this.client.chat
            .delete({ channel: this.channel, ts: this.placeholderTs })
            .catch(() => {});
        }
        return this.placeholderTs;
      })
      .catch(() => {
        this.placeholderResolved = true;
        return null;
      });
  }

  private ensureNotes(): SlackTextStream {
    if (!this.notes) {
      this.notes = new SlackTextStream(this.client, this.channel, this.threadTs, {
        recipientTeamId: this.recipientTeamId,
        recipientUserId: this.recipientUserId,
        prefix: STREAM_LIVE_NOTES_PREFIX,
        onStart: () => this.removePlaceholder(),
      });
    }
    return this.notes;
  }

  /**
   * Append a segment to the accumulated notes (the source for the final collapsed
   * attachment), inserting the right separator for the transition: consecutive
   * reasoning deltas get none; switching to/from a tool line gets a single
   * newline (a list item); any other paragraph transition gets a blank line.
   *
   * Narration (`kind === 'narration'`) is collected but NOT streamed to the live
   * notes message — it is already visible live in the answer bubble (it arrives
   * as answer text), so streaming it here too would show it twice. It still lands
   * in the end-of-turn attachment, where the answer bubble no longer carries it.
   */
  private writeNote(text: string, kind: 'reasoning' | 'tool' | 'narration'): void {
    if (text.length === 0) return;
    let sep = '';
    if (this.notesText.length > 0 && !/\n\s*$/.test(this.notesText)) {
      if (kind === 'reasoning' && this.lastNoteKind === 'reasoning') {
        sep = ''; // mid-stream reasoning — no break between deltas
      } else if (kind === 'tool' || this.lastNoteKind === 'tool') {
        sep = '\n'; // tool steps are single-line list items
      } else {
        sep = '\n\n';
      }
    }
    this.lastNoteKind = kind;
    const chunk = sep + text;
    this.notesText += chunk;
    if (kind !== 'narration') this.ensureNotes().write(chunk);
  }

  /** A reasoning/tool boundary: any buffered answer run before it was narration. */
  private flushNarration(): void {
    const run = this.pendingTextRun.trim();
    this.pendingTextRun = '';
    if (run.length === 0) return;
    this.writeNote(run, 'narration');
    this.answerDirty = true; // narration leaked into the live answer stream
  }

  onReasoningDelta(text: string): void {
    if (!this.collapse || this.finished || text.length === 0) return;
    this.flushNarration();
    this.writeNote(text, 'reasoning');
  }

  onTextDelta(text: string): void {
    if (this.finished) return;
    this.answerText += text;
    this.pendingTextRun += text;
    this.answer.write(text);
  }

  onToolEvent(event: ToolEventPayload): void {
    if (this.finished) return;
    if (this.collapse) {
      this.handleToolNote(event);
    } else {
      this.statusChain = this.statusChain
        .then(() => this.handleStatusMessage(event))
        .catch(() => {});
    }
  }

  /** Collapse path: tool steps become lines in the live notes log. */
  private handleToolNote(event: ToolEventPayload): void {
    this.flushNarration();
    let line: string | null = null;
    if (event.phase === 'complete') {
      line = formatToolNote(event.toolName, event.keyArg);
    } else if (event.phase === 'subagent_progress') {
      line = `:small_blue_diamond: _${event.toolName}: ${event.description}_`;
    } else if (event.phase === 'subagent_completed') {
      line = `:small_blue_diamond: _${event.toolName} done${event.description ? `: ${event.description}` : ''}_`;
    }
    // 'start' is intentionally skipped — the 'complete' line carries the key arg.
    if (!line) return;
    this.writeNote(line, 'tool');
  }

  /**
   * No-collapse path: a single self-replacing status line. The first status
   * takes over the "thinking…" placeholder bubble (so the user never sees both a
   * placeholder AND a separate status at once); later events edit it in place.
   * When the answer stream opens it deletes that bubble, after which a fresh
   * status is posted for any subsequent tool.
   */
  private async handleStatusMessage(event: ToolEventPayload): Promise<void> {
    const text = formatToolStatus(event.toolName, event.phase === 'complete' ? event.keyArg : null);
    if (this.statusTs) {
      await this.client.chat.update({ channel: this.channel, ts: this.statusTs, text });
      return;
    }
    // No active status line: adopt the placeholder bubble if it is still present.
    const placeholderTs = await this.placeholderPromise;
    if (placeholderTs && !this.placeholderDeleted) {
      this.statusTs = placeholderTs;
      this.statusAdoptedPlaceholder = true;
      await this.client.chat.update({ channel: this.channel, ts: placeholderTs, text });
    } else {
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
      });
      this.statusTs = res.ts ?? null;
    }
  }

  private removePlaceholder(): void {
    if (this.placeholderDeleted) return;
    this.placeholderDeleted = true;
    // If the post hasn't resolved yet, the .then() in the constructor deletes it.
    if (this.placeholderResolved && this.placeholderTs) {
      this.client.chat.delete({ channel: this.channel, ts: this.placeholderTs }).catch(() => {});
      this.placeholderTs = null;
    }
    // If the no-collapse status line had taken over that bubble, it is now gone —
    // clear the ref so the next tool event posts a fresh status.
    if (this.statusAdoptedPlaceholder) {
      this.statusTs = null;
      this.statusAdoptedPlaceholder = false;
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // The final text run (nothing followed it) is the answer — leave it in the
    // answer stream; do NOT flush it to notes.
    await Promise.all([this.notes?.finish(), this.answer.finish()]);
    await this.statusChain.catch(() => {});
    await this.placeholderPromise.catch(() => {});
    // Drop the status message (no-collapse path) and any lingering placeholder. If
    // the status adopted the placeholder bubble they're the same message — list it
    // once.
    const placeholderLeftover =
      this.placeholderDeleted || this.statusAdoptedPlaceholder ? null : this.placeholderTs;
    const leftovers = [this.statusTs, placeholderLeftover];
    this.statusTs = null;
    this.placeholderTs = null;
    for (const ts of leftovers) {
      if (!ts) continue;
      try {
        await this.client.chat.delete({ channel: this.channel, ts });
      } catch {
        // Best effort
      }
    }
  }

  getFullText(): string {
    return this.answerText;
  }

  /** ts of the answer stream, if it ever started. */
  getStreamTs(): string | null {
    return this.answer.ts;
  }

  /** True only if the answer stream exists and was not finalized early by Slack. */
  streamDeliveredOk(): boolean {
    return this.answer.deliveredOk;
  }

  /** True if narration leaked into the live answer stream and it must be rebuilt. */
  isAnswerDirty(): boolean {
    return this.answerDirty;
  }

  /** ts of the live working-notes stream, if any reasoning/tool/narration occurred. */
  getNotesTs(): string | null {
    return this.notes?.ts ?? null;
  }

  /** Accumulated working-notes content (reasoning + tool steps + narration). */
  getNotesText(): string {
    return this.notesText;
  }
}

async function sendResponse(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  if (text.length > FILE_THRESHOLD) {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      content: text,
      filename: 'response.md',
      snippet_type: 'markdown',
      title: 'Response',
    });
    return;
  }

  // Convert standard Markdown → Slack mrkdwn before sending
  const formatted = markdownToSlackMrkdwn(text);

  const chunks = splitMessage(formatted);
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunk,
    });
  }
}

export class SlackChannelResponder implements ChannelResponder {
  private client: WebClient;
  private channelId: string;
  private threadTs: string;
  private messageTs: string;
  private responseMode: ResponseMode;
  private teamId?: string;
  private userId: string;
  private collapseWorkingNotes: boolean;

  constructor(
    client: WebClient,
    channelId: string,
    threadTs: string,
    messageTs: string,
    responseMode: ResponseMode,
    userId: string,
    teamId?: string,
    collapseWorkingNotes = true,
  ) {
    this.client = client;
    this.channelId = channelId;
    this.threadTs = threadTs;
    this.messageTs = messageTs;
    this.responseMode = responseMode;
    this.userId = userId;
    this.teamId = teamId;
    this.collapseWorkingNotes = collapseWorkingNotes;
  }

  async onProcessing(): Promise<void> {
    await safeReact(this.client, this.channelId, this.messageTs, 'hourglass_flowing_sand');
    await safeReact(this.client, this.channelId, this.messageTs, 'inbox_tray', 'remove');
  }

  async onComplete(): Promise<void> {
    await safeReact(this.client, this.channelId, this.messageTs, 'ballot_box_with_check');
    await safeReact(
      this.client,
      this.channelId,
      this.messageTs,
      'hourglass_flowing_sand',
      'remove',
    );
  }

  async onError(message: string): Promise<void> {
    await safeReact(this.client, this.channelId, this.messageTs, 'x');
    await safeReact(
      this.client,
      this.channelId,
      this.messageTs,
      'hourglass_flowing_sand',
      'remove',
    );
    try {
      await this.client.chat.postMessage({
        channel: this.channelId,
        thread_ts: this.threadTs,
        text: `:warning: Error: ${message}`,
      });
    } catch (replyErr) {
      console.error(`[slack] Failed to send error reply:`, replyErr);
    }
  }

  async sendResponse(text: string): Promise<void> {
    await sendResponse(this.client, this.channelId, this.threadTs, text);
  }

  createStreamingResponder(): IStreamingResponder {
    if (this.responseMode === 'stream-native') {
      return new NativeStreamingResponder(this.client, this.channelId, this.threadTs, {
        recipientTeamId: this.teamId,
        recipientUserId: this.userId,
        collapseWorkingNotes: this.collapseWorkingNotes,
      });
    }
    return new StreamingResponder(this.client, this.channelId, this.threadTs);
  }

  async onStreamComplete(finalText: string, responder: IStreamingResponder): Promise<void> {
    if (this.responseMode === 'stream-native') {
      const nsr = responder as NativeStreamingResponder;
      const clean = finalText.trim();

      // Collapse the live working-notes stream into an attachment IN PLACE. It was
      // started before the answer stream, so editing it keeps it above the answer
      // (a message's thread position is fixed at creation, unchanged by edits).
      if (this.collapseWorkingNotes) {
        await this.collapseNotes(nsr.getNotesTs(), nsr.getNotesText());
      }

      // Ensure the answer slot shows the clean, authoritative answer. Leave the
      // live answer untouched only when it streamed cleanly to the end AND no
      // narration leaked into it; otherwise rebuild it from `result.text`.
      const answerTs = nsr.getStreamTs();
      const needsRebuild = !nsr.streamDeliveredOk() || nsr.isAnswerDirty();
      if (clean.length > 0 && (needsRebuild || finalText.length > FILE_THRESHOLD)) {
        await this.deliverFinalText(finalText, answerTs);
      } else if (clean.length === 0 && answerTs) {
        // No answer text at all (e.g. reasoning-only turn) — drop the empty bubble.
        await this.deleteMessage(answerTs);
      }
      return;
    }
    const fullText = finalText;

    // stream-update mode: handle oversized responses
    const sr = responder as StreamingResponder;
    if (fullText.length > FILE_THRESHOLD) {
      // Upload as a file, THEN delete the streamed message — upload first so a
      // failed upload never loses the only copy of the response.
      await this.client.files.uploadV2({
        channel_id: this.channelId,
        thread_ts: this.threadTs,
        content: fullText,
        filename: 'response.md',
        snippet_type: 'markdown',
        title: 'Response',
      });
      const msgTs = sr.getMessageTs();
      if (msgTs) {
        try {
          await this.client.chat.delete({ channel: this.channelId, ts: msgTs });
        } catch {
          // Best effort — may lack permission
        }
      }
    } else if (fullText.length > MAX_MESSAGE_LENGTH) {
      // Final text fits in messages but was truncated during streaming — do a final complete send
      const formatted = markdownToSlackMrkdwn(fullText);
      const chunks = splitMessage(formatted);
      const msgTs = sr.getMessageTs();
      if (msgTs && chunks.length > 0) {
        try {
          await this.client.chat.update({
            channel: this.channelId,
            ts: msgTs,
            text: chunks[0],
          });
        } catch {
          // Fall through to post
        }
        // Post remaining chunks as follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await this.client.chat.postMessage({
            channel: this.channelId,
            thread_ts: this.threadTs,
            text: chunks[i],
          });
        }
      }
    }
  }

  /**
   * Deliver the clean final text into the answer-stream message slot. Used when
   * the answer must be rebuilt — Slack finalized the stream early (idle timeout)
   * or narration leaked into the live answer. Overwrites the streamed message in
   * place (no duplicate bubble) when its ts is known; otherwise posts the text as
   * fresh threaded message(s). Oversized text is uploaded as a file.
   */
  private async deliverFinalText(fullText: string, streamTs: string | null): Promise<void> {
    if (fullText.length > FILE_THRESHOLD) {
      // Too large for a message — upload as a file, THEN drop the partial streamed
      // message. Upload first so a failed upload never loses the only copy of the
      // response (the partial message stays as a fallback).
      await this.client.files.uploadV2({
        channel_id: this.channelId,
        thread_ts: this.threadTs,
        content: fullText,
        filename: 'response.md',
        snippet_type: 'markdown',
        title: 'Response',
      });
      if (streamTs) {
        try {
          await this.client.chat.delete({ channel: this.channelId, ts: streamTs });
        } catch {
          // Best effort — may lack permission
        }
      }
      return;
    }

    const chunks = splitMessage(markdownToSlackMrkdwn(fullText));
    if (chunks.length === 0) return;
    let startIdx = 0;
    // Overwrite the partial (auto-finalized) streamed message with the full first chunk.
    if (streamTs) {
      try {
        await this.client.chat.update({
          channel: this.channelId,
          ts: streamTs,
          text: chunks[0],
        });
        startIdx = 1;
      } catch {
        // Couldn't update the finalized message — post everything fresh below.
      }
    }
    for (let i = startIdx; i < chunks.length; i++) {
      await this.client.chat.postMessage({
        channel: this.channelId,
        thread_ts: this.threadTs,
        text: chunks[i],
      });
    }
  }

  /**
   * Collapse the live working-notes stream IN PLACE into a "🧠 Working notes"
   * attachment. After `stopStream` the streamed message is a normal message, so
   * `chat.update` with new `text` + empty `blocks` cleanly replaces the streamed
   * markdown, and the attachment auto-collapses behind Slack's "Show more…" once
   * it passes ~700 chars / 5 line breaks. Editing does not move the message, so
   * it stays above the answer (it was started first). Best effort — failure must
   * not block delivery of the answer.
   */
  private async collapseNotes(notesTs: string | null, notes: string): Promise<void> {
    const trimmed = stripStreamArtifacts(notes).trim();
    if (!trimmed) {
      // Nothing worth keeping — drop the live bubble if one was opened.
      await this.deleteMessage(notesTs);
      return;
    }
    const body =
      trimmed.length > WORKING_NOTES_MAX_CHARS
        ? `${trimmed.slice(0, WORKING_NOTES_MAX_CHARS)}\n\n_…(truncated)_`
        : trimmed;
    const attachments = [
      {
        color: '#9b9b9b',
        fallback: WORKING_NOTES_TITLE,
        text: markdownToSlackMrkdwn(body),
        mrkdwn_in: ['text' as const],
      },
    ];
    try {
      if (notesTs) {
        // Collapse the live notes message IN PLACE (stays above the answer).
        await this.client.chat.update({
          channel: this.channelId,
          ts: notesTs,
          text: WORKING_NOTES_TITLE, // header + notification fallback
          blocks: [], // clear the streamed markdown block
          attachments,
        });
      } else {
        // The live notes stream never opened (e.g. notes hold only narration that
        // was shown in the answer bubble), but there is content to archive — post
        // it fresh so the narration/notes aren't lost.
        await this.client.chat.postMessage({
          channel: this.channelId,
          thread_ts: this.threadTs,
          text: WORKING_NOTES_TITLE,
          attachments,
        });
      }
    } catch (err) {
      console.error('[slack] Failed to collapse working notes:', err);
    }
  }

  /** Best-effort delete of a message by ts (may lack permission). */
  private async deleteMessage(ts: string | null): Promise<void> {
    if (!ts) return;
    try {
      await this.client.chat.delete({ channel: this.channelId, ts });
    } catch {
      // Best effort — may lack permission
    }
  }

  async uploadFile(filePath: string): Promise<void> {
    const filename = basename(filePath);
    const snippetType = getSnippetType(filename);
    await this.client.files.uploadV2({
      channel_id: this.channelId,
      thread_ts: this.threadTs,
      file: filePath,
      filename,
      title: filename,
      ...(snippetType ? { snippet_type: snippetType } : {}),
    });
  }

  async warn(message: string): Promise<void> {
    await warnInThread(this.client, this.channelId, this.threadTs, message);
  }
}
