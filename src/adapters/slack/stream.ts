import type { WebClient } from '@slack/web-api';
import type { AnyChunk, MarkdownTextChunk, TaskUpdateChunk } from '@slack/types';
import type { Block, KnownBlock } from '@slack/types';
import {
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
  STREAM_NATIVE_APPEND_RATE_PER_MIN,
  STREAM_NATIVE_APPEND_BURST,
} from './formatting.js';

/**
 * Slack errors that mean the stream is permanently gone (no further appends or
 * stop will ever succeed). Anything else — rate limits, network blips, 5xx — is
 * treated as transient: we keep the stream open and retry rather than tearing
 * it down and triggering the full-text fallback.
 */
const STREAM_CLOSED_ERROR_CODES = new Set(['message_not_in_streaming_state', 'stopped_by_user']);

export function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | undefined)?.data?.error;
}

export function isStreamClosedError(err: unknown): boolean {
  const code = slackErrorCode(err);
  return code != null && STREAM_CLOSED_ERROR_CODES.has(code);
}

/**
 * Shared token bucket for `chat.appendStream` across every active stream.
 * appendStream is Tier 4 (100+/min) and the budget is per workspace token, not
 * per message — so all streaming responder instances draw from this one bucket.
 * Callers check `tryConsumeAppendToken()` before appending; when it returns
 * false they defer to their next flush tick instead of calling the API. One
 * append call carries a whole chunk batch, so the math is per call.
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

/** Retry delays for the finalization calls (stopStream / final update). */
const FINALIZE_RETRY_DELAYS_MS = [500, 1500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One native Slack streaming message for a whole Claude turn, carrying an
 * ordered queue of chunks: `markdown_text` for answer/narration text and
 * `task_update` for the Thinking Steps work log. Timer-batched flushing, idle
 * keepalives, and resilience to Slack finalizing the stream out from under us.
 *
 * Spike-verified Slack behavior this class encodes (2026-07-02, see
 * docs/plans/2026-07-02-slack-thinking-steps-streaming.md):
 * - a stream started with `chunks` rejects the bare `markdown_text` param on
 *   append/stop (`streaming_mode_mismatch`) — everything goes through `chunks`;
 * - same-id `task_update` re-sends are idempotent (used as invisible keepalive);
 * - over-cap task fields are truncated server-side, not rejected.
 */
export class SlackTurnStream {
  private streamTs: string | null = null;
  private streamBroken = false;
  /** Ordered un-acked chunks — trimmed only after a successful send. */
  private pending: AnyChunk[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastWriteAt = 0;
  private flushing = false;
  private currentFlush: Promise<void> = Promise.resolve();
  private started = false;
  private finished = false;
  /** Last task_update sent — re-sent idempotently as an invisible keepalive. */
  private lastTaskUpdate: TaskUpdateChunk | null = null;

  constructor(
    private client: WebClient,
    private channel: string,
    private threadTs: string,
    private options: {
      recipientTeamId?: string;
      recipientUserId?: string;
      /** Called once, when startStream first returns a ts. */
      onStart?: () => void;
    } = {},
  ) {}

  /** Open the stream eagerly with the given initial chunks (e.g. a Thinking card). */
  start(initialChunks: AnyChunk[]): void {
    if (this.started || this.finished) return;
    this.started = true;
    this.pending.push(...initialChunks);
    this.lastWriteAt = Date.now();
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.onFlushTick(), STREAM_NATIVE_FLUSH_INTERVAL_MS);
    }
    // Flush immediately so the message appears without waiting a full interval;
    // later chunks are batched by the timer.
    this.kickFlush(false);
  }

  /** Queue answer/narration text; coalesces into the trailing markdown chunk. */
  appendMarkdown(text: string): void {
    if (this.streamBroken || this.finished || text.length === 0) return;
    const last = this.pending[this.pending.length - 1];
    if (last?.type === 'markdown_text') {
      (last as MarkdownTextChunk).text += text;
    } else {
      this.pending.push({ type: 'markdown_text', text });
    }
    this.ensureStarted();
  }

  /** Queue a task card update; coalesces adjacent same-id updates (last wins). */
  appendTask(update: TaskUpdateChunk): void {
    if (this.streamBroken || this.finished) return;
    const last = this.pending[this.pending.length - 1];
    if (last?.type === 'task_update' && (last as TaskUpdateChunk).id === update.id) {
      this.pending[this.pending.length - 1] = update;
    } else {
      this.pending.push(update);
    }
    this.ensureStarted();
  }

  private ensureStarted(): void {
    if (!this.started) this.start([]);
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

  /**
   * Invisible keepalive chunk: prefer an idempotent re-send of the last
   * task_update (renders as a no-op); before any task exists, fall back to a
   * zero-width space markdown chunk.
   */
  private keepaliveChunks(): AnyChunk[] {
    if (this.lastTaskUpdate) return [{ ...this.lastTaskUpdate }];
    return [{ type: 'markdown_text', text: STREAM_KEEPALIVE_TOKEN }];
  }

  private async flushPending(keepalive: boolean): Promise<void> {
    if (this.streamBroken) return;
    if (this.pending.length === 0 && !keepalive) return;
    // Detach the batch so concurrent append*() calls can't mutate chunks that
    // are already serialized into an in-flight request (their coalescing would
    // be silently lost when the batch is trimmed). Restored on transient failure.
    const batch = this.pending.splice(0, this.pending.length);
    const chunks = batch.length > 0 ? batch : this.keepaliveChunks();
    try {
      if (this.streamTs === null) {
        const res = await this.client.chat.startStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          // 'plan' groups every task card into ONE collapsible box (titled via a
          // plan_update chunk); 'timeline' renders each card as its own box,
          // which reads as clutter for multi-tool turns.
          task_display_mode: 'plan',
          chunks,
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
          chunks,
        });
      }
      this.rememberLastTask(chunks);
      this.lastWriteAt = Date.now();
    } catch (err) {
      // Put the unsent batch back in front of anything queued meanwhile so a
      // retry preserves content and order.
      if (batch.length > 0) this.pending = [...batch, ...this.pending];
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

  private rememberLastTask(sent: AnyChunk[]): void {
    for (let i = sent.length - 1; i >= 0; i--) {
      if (sent[i].type === 'task_update') {
        this.lastTaskUpdate = sent[i] as TaskUpdateChunk;
        return;
      }
    }
  }

  /**
   * Finalize the stream: stopStream with any queued tail plus the given closing
   * chunks and optional final blocks (Slack appends them to the message end).
   * Retries transient failures so a single 429/network blip can't leave the
   * message expanded/live. Idempotent.
   */
  async stop(opts: { chunks?: AnyChunk[]; blocks?: (KnownBlock | Block)[] } = {}): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopFlushLoop();
    await this.currentFlush.catch(() => {});
    if (this.streamTs === null || this.streamBroken) return;
    const tail = [...this.pending, ...(opts.chunks ?? [])];
    this.pending = [];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.chat.stopStream({
          channel: this.channel,
          ts: this.streamTs,
          ...(tail.length > 0 ? { chunks: tail } : {}),
          ...(opts.blocks ? { blocks: opts.blocks } : {}),
        });
        return;
      } catch (err) {
        const code = slackErrorCode(err);
        if (isStreamClosedError(err)) {
          this.streamBroken = true;
          console.error('[native-stream] stream already finalized at stop:', code);
          return;
        }
        // Final blocks rejected (e.g. container block not accepted) — retry once
        // without blocks so the stream still finalizes; the caller detects the
        // missing delivery via `finalBlocksDelivered` and falls back.
        if ((code === 'invalid_blocks' || code === 'invalid_arguments') && opts.blocks) {
          console.error('[native-stream] final blocks rejected, stopping without them:', code);
          opts = { ...opts, blocks: undefined };
          this.finalBlocksRejected = true;
          continue;
        }
        if (attempt >= FINALIZE_RETRY_DELAYS_MS.length) {
          this.streamBroken = true;
          console.error('[native-stream] failed to stop stream:', code ?? err);
          return;
        }
        console.error(
          `[native-stream] stopStream failed (attempt ${attempt + 1}), retrying:`,
          code ?? err,
        );
        await sleep(FINALIZE_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  private finalBlocksRejected = false;

  get ts(): string | null {
    return this.streamTs;
  }

  /** True only if the stream message exists and was not finalized early by Slack. */
  get deliveredOk(): boolean {
    return this.streamTs !== null && !this.streamBroken;
  }

  /** True if `stop` had to drop the final blocks to get the stream finalized. */
  get droppedFinalBlocks(): boolean {
    return this.finalBlocksRejected;
  }
}
