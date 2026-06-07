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
  MAX_MESSAGE_LENGTH,
  FILE_THRESHOLD,
  STREAM_UPDATE_INTERVAL_MS,
  STREAMING_INDICATOR,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
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

class NativeStreamingResponder implements IStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientTeamId?: string;
  private recipientUserId?: string;
  private fullText = '';
  private thinkingTs: string | null;
  private statusTs: string | null = null;
  private finished = false;
  private toolEventChain: Promise<void> = Promise.resolve();
  /** Whether the stream lifecycle has been kicked off (timer + first flush). */
  private started = false;
  /** ts of the streamed message, set from the startStream response. */
  private streamTs: string | null = null;
  /**
   * Set once Slack finalizes the stream out from under us (idle-timeout →
   * `message_not_in_streaming_state`). Once broken, we stop calling appendStream
   * and let finish()/onStreamComplete deliver the full text instead.
   */
  private streamBroken = false;
  /**
   * The single source of truth for un-acked text. Text is removed only after a
   * successful send, so a transient failure simply retries the same bytes on the
   * next tick — there is no second buffer that could double it.
   */
  private pending = '';
  /** Timer that flushes pending text and sends idle keepalives. */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp (ms) of the last successful append/keepalive — drives keepalive. */
  private lastWriteAt = 0;
  /** At most one flush is scheduled/in-flight at a time (no unbounded queue). */
  private flushing = false;
  /** The latest in-flight flush, awaited by finish(). */
  private currentFlush: Promise<void> = Promise.resolve();

  constructor(
    client: WebClient,
    channel: string,
    threadTs: string,
    options?: { thinkingTs?: string; recipientTeamId?: string; recipientUserId?: string },
  ) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
    this.thinkingTs = options?.thinkingTs ?? null;
    this.recipientTeamId = options?.recipientTeamId;
    this.recipientUserId = options?.recipientUserId;
  }

  onToolEvent(event: ToolEventPayload): void {
    this.toolEventChain = this.toolEventChain
      .then(() => this.handleToolEvent(event))
      .catch(() => {});
  }

  private async handleToolEvent(event: ToolEventPayload): Promise<void> {
    const text = formatToolStatus(event.toolName, event.phase === 'complete' ? event.keyArg : null);
    if (this.thinkingTs && !this.statusTs) {
      // Reuse the existing thinking message as the status message
      await this.client.chat.update({
        channel: this.channel,
        ts: this.thinkingTs,
        text,
      });
      this.statusTs = this.thinkingTs;
      this.thinkingTs = null;
    } else if (this.statusTs) {
      // Update existing status message
      await this.client.chat.update({
        channel: this.channel,
        ts: this.statusTs,
        text,
      });
    } else {
      // Post new status message (e.g., tool use between text turns)
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
      });
      this.statusTs = res.ts ?? null;
    }
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    // Text always accumulates in fullText above; once the stream is finalized
    // (or we've finished), stop touching the streaming API and let the full text
    // be delivered by onStreamComplete.
    if (this.streamBroken || this.finished) return;
    this.pending += text;
    if (!this.started) {
      this.started = true;
      this.lastWriteAt = Date.now();
      this.startFlushLoop();
      // Flush the first chunk immediately (this opens the stream via startStream)
      // so the message appears without waiting a full interval; later deltas are
      // batched by the timer.
      this.kickFlush(false);
    }
  }

  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.onFlushTick(), STREAM_NATIVE_FLUSH_INTERVAL_MS);
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
    // Only one flush in flight at a time — if the previous Slack call is still
    // pending, skip this tick rather than queue another (and burn a token).
    if (this.flushing) return;
    const now = Date.now();
    const wantKeepalive =
      this.pending.length === 0 && now - this.lastWriteAt >= STREAM_NATIVE_KEEPALIVE_MS;
    if (this.pending.length === 0 && !wantKeepalive) return;
    // Consume a token from the shared appendStream budget only when we are
    // actually about to call the API; defer to the next tick if exhausted.
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
    const text = this.pending; // single source of truth — cleared only on success
    if (!text && !keepalive) return;
    const toSend = text.length > 0 ? text : STREAM_KEEPALIVE_TOKEN;
    try {
      if (this.streamTs === null) {
        const res = await this.client.chat.startStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          markdown_text: toSend,
          ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
          ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
        });
        if (!res?.ts) {
          // Shouldn't happen; bail rather than retry (a retry would start a 2nd
          // stream message). onStreamComplete delivers the full text instead.
          this.streamBroken = true;
          this.stopFlushLoop();
          console.error('[native-stream] startStream returned no ts');
          return;
        }
        this.streamTs = res.ts;
        // The stream message now exists — drop the thinking/status placeholder.
        this.deleteThinkingMessage();
      } else {
        await this.client.chat.appendStream({
          channel: this.channel,
          ts: this.streamTs,
          markdown_text: toSend,
        });
      }
      // Remove only the bytes we sent; keep any deltas that arrived mid-flight.
      if (text.length > 0) this.pending = this.pending.slice(text.length);
      this.lastWriteAt = Date.now();
    } catch (err) {
      const code = slackErrorCode(err);
      if (isStreamClosedError(err)) {
        // Slack finalized the stream (e.g. idle timeout during a long tool call):
        // every further append/stop will fail too. Tear down and let
        // onStreamComplete deliver the full text.
        this.streamBroken = true;
        this.stopFlushLoop();
        console.error('[native-stream] stream finalized early:', code);
      } else {
        // Transient (rate limit, network, 5xx — already SDK-retried). pending is
        // left untouched, so the next tick retries exactly the same bytes once.
        console.error('[native-stream] append failed, will retry:', code ?? err);
      }
    }
  }

  private deleteThinkingMessage(): void {
    const ts = this.statusTs ?? this.thinkingTs;
    this.statusTs = null;
    this.thinkingTs = null;
    if (ts) this.client.chat.delete({ channel: this.channel, ts }).catch(() => {});
  }

  async finish(): Promise<void> {
    if (this.finished) return; // idempotent — engine cleanup may call this twice
    this.finished = true;
    this.stopFlushLoop();
    // Let the in-flight flush settle (it keeps the stream alive while pending),
    // so `pending` is final before we finalize.
    await this.currentFlush.catch(() => {});

    // Finalize the stream FIRST. The keepalive timer is already stopped, so any
    // delay here (e.g. a slow/retrying status-message delete below) would leave
    // the stream idle long enough for Slack to expire it — finalize before that
    // window opens.
    if (this.streamTs !== null && !this.streamBroken) {
      const tail = this.pending; // flush the tail as part of stopStream
      this.pending = '';
      try {
        await this.client.chat.stopStream({
          channel: this.channel,
          ts: this.streamTs,
          ...(tail ? { markdown_text: tail } : {}),
        });
      } catch (err) {
        // stopStream failed (terminal or transient). Either way we're done, so
        // hand off to onStreamComplete, which delivers the complete text (and its
        // in-place repair re-posts fresh if the message is somehow still live).
        this.streamBroken = true;
        console.error('[native-stream] failed to stop stream:', slackErrorCode(err) ?? err);
      }
    }

    // Now that the stream is finalized, settle the tool-status chain and remove
    // any lingering placeholder — the original thinking message if the stream
    // never started, or a tool-status message posted mid-stream after the
    // thinking one was already cleared. Either way it must not survive.
    await this.toolEventChain.catch(() => {});
    const cleanupTs = this.statusTs ?? this.thinkingTs;
    this.statusTs = null;
    this.thinkingTs = null;
    if (cleanupTs) {
      try {
        await this.client.chat.delete({ channel: this.channel, ts: cleanupTs });
      } catch {
        // Best effort
      }
    }
  }

  getFullText(): string {
    return this.fullText;
  }

  /** ts of the streamed message, if the stream ever started. */
  getStreamTs(): string | null {
    return this.streamTs;
  }

  /** True only if the stream message exists and was not finalized early by Slack. */
  streamDeliveredOk(): boolean {
    return this.streamTs !== null && !this.streamBroken;
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

  constructor(
    client: WebClient,
    channelId: string,
    threadTs: string,
    messageTs: string,
    responseMode: ResponseMode,
    userId: string,
    teamId?: string,
  ) {
    this.client = client;
    this.channelId = channelId;
    this.threadTs = threadTs;
    this.messageTs = messageTs;
    this.responseMode = responseMode;
    this.userId = userId;
    this.teamId = teamId;
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
      // Post a thinking message for immediate visual feedback
      // NativeStreamingResponder handles its own thinking message lifecycle,
      // but we need to post it before returning. Use a sync constructor
      // and handle the thinking message asynchronously inside.
      return new NativeStreamingResponderWithThinking(
        this.client,
        this.channelId,
        this.threadTs,
        this.teamId,
        this.userId,
      );
    }
    return new StreamingResponder(this.client, this.channelId, this.threadTs);
  }

  async onStreamComplete(fullText: string, responder: IStreamingResponder): Promise<void> {
    if (this.responseMode === 'stream-native') {
      const nsr = responder as NativeStreamingResponderWithThinking;
      // If Slack finalized the stream early (idle timeout → message_not_in_streaming_state),
      // the live updates stopped and the post-timeout text never landed. Deliver the full
      // text now, repairing the partial streamed message in place when we know its ts.
      if (!nsr.streamDeliveredOk() && fullText.trim().length > 0) {
        await this.deliverNativeFallback(fullText, nsr.getStreamTs());
        return;
      }
      // Native streaming handled display; fall back to file upload for huge responses
      if (fullText.length > FILE_THRESHOLD) {
        await this.client.files.uploadV2({
          channel_id: this.channelId,
          thread_ts: this.threadTs,
          content: fullText,
          filename: 'response.md',
          snippet_type: 'markdown',
          title: 'Response',
        });
      }
      return;
    }

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
   * Deliver the complete response when the native stream was finalized early by Slack.
   * Repairs the partial streamed message in place (no duplicate bubble) when its ts is
   * known; otherwise posts the text as fresh threaded message(s).
   */
  private async deliverNativeFallback(fullText: string, streamTs: string | null): Promise<void> {
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

/**
 * NativeStreamingResponder that posts its own thinking message on first use.
 * The thinking message is posted lazily (on first onTextDelta or onToolEvent).
 */
class NativeStreamingResponderWithThinking implements IStreamingResponder {
  private inner: NativeStreamingResponder | null = null;
  private innerPromise: Promise<NativeStreamingResponder> | null = null;
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private teamId?: string;
  private userId: string;
  private thinkingPromise: Promise<string | undefined>;
  private fullText = '';

  constructor(
    client: WebClient,
    channel: string,
    threadTs: string,
    teamId: string | undefined,
    userId: string,
  ) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
    this.teamId = teamId;
    this.userId = userId;

    // Post thinking message immediately
    this.thinkingPromise = client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: ':thinking_face: _thinking..._',
      })
      .then((res) => res.ts ?? undefined)
      .catch(() => undefined);
  }

  private ensureInner(): Promise<NativeStreamingResponder> {
    if (!this.innerPromise) {
      this.innerPromise = this.thinkingPromise.then((thinkingTs) => {
        this.inner = new NativeStreamingResponder(this.client, this.channel, this.threadTs, {
          thinkingTs,
          recipientTeamId: this.teamId,
          recipientUserId: this.userId,
        });
        // Replay any text that arrived before inner was ready
        if (this.fullText) {
          this.inner.onTextDelta(this.fullText);
        }
        return this.inner;
      });
    }
    return this.innerPromise;
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    if (this.inner) {
      this.inner.onTextDelta(text);
    } else {
      // Trigger async initialization; text is replayed in ensureInner
      this.ensureInner().catch(() => {});
    }
  }

  onToolEvent(event: ToolEventPayload): void {
    if (this.inner) {
      this.inner.onToolEvent(event);
    } else {
      this.ensureInner()
        .then((inner) => inner.onToolEvent(event))
        .catch(() => {});
    }
  }

  async finish(): Promise<void> {
    const inner = await this.ensureInner();
    await inner.finish();
  }

  getFullText(): string {
    return this.inner?.getFullText() ?? this.fullText;
  }

  getStreamTs(): string | null {
    return this.inner?.getStreamTs() ?? null;
  }

  streamDeliveredOk(): boolean {
    return this.inner?.streamDeliveredOk() ?? false;
  }
}
