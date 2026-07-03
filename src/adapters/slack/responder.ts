import { basename } from 'path';
import type { WebClient } from '@slack/web-api';
import type {
  ChannelResponder,
  IStreamingResponder,
  StreamOutcome,
  ToolEventPayload,
} from '../../core/interfaces.js';
import type { ResponseMode } from '../../config.js';
import {
  markdownToSlackMrkdwn,
  splitDetails,
  formatToolStatus,
  MAX_MESSAGE_LENGTH,
  FILE_THRESHOLD,
  NARRATION_HOLDBACK_MAX_CHARS,
  STREAM_UPDATE_INTERVAL_MS,
  STREAMING_INDICATOR,
  ANSWER_STREAMING_REACTION,
  WORK_LOG_TITLE,
} from './formatting.js';
import { SlackTurnStream } from './stream.js';
import { TaskTracker, DetailsGate } from './thinking-steps.js';
import { deliverText } from './delivery.js';
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
  /** ts the streaming reaction was placed on (the response message), if any. */
  private reactionTs: string | null = null;
  /** The in-flight reaction `add`, awaited before the `remove` so they can't race. */
  private reactionAdd: Promise<void> = Promise.resolve();

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
        // Add the streaming reaction to the response message once it exists;
        // removed in finish(). Best effort.
        if (this.messageTs && !this.reactionTs) {
          this.reactionTs = this.messageTs;
          this.reactionAdd = safeReact(
            this.client,
            this.channel,
            this.messageTs,
            ANSWER_STREAMING_REACTION,
          );
        }
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
    // Streaming done — drop the reaction from the response message. Await the add
    // first so a fast finish can't remove before the add lands.
    if (this.reactionTs) {
      await this.reactionAdd;
      await safeReact(
        this.client,
        this.channel,
        this.reactionTs,
        ANSWER_STREAMING_REACTION,
        'remove',
      );
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
 * Drives one native Slack streaming message per Claude turn using Thinking
 * Steps chunks:
 *
 * - tool events and (when enabled) reasoning bursts become live `task_update`
 *   cards, which Slack renders expandable while streaming and collapsed by
 *   default once done — the work log needs no post-hoc collapsing;
 * - answer-role text is buffered per run and classified: a run interrupted by
 *   a tool/reasoning event was narration ("Let me check the files…") and is
 *   demoted to a completed work-log card; a run that outgrows the holdback
 *   cap (or survives to the end of the turn) is the answer and streams to the
 *   body as `markdown_text` chunks;
 * - a {@link DetailsGate} rewrites the `-- DETAILS --` marker line into an
 *   inline header, so the details section streams live inside the same
 *   message instead of arriving as a folded block at stop.
 *
 * The stream opens eagerly with a "Thinking" card, which doubles as the
 * instant-feedback placeholder. `finish` is crash-proof: on a failed turn the
 * open cards flip to `error` and the stream is still stopped, so the work log
 * always ends collapsed.
 */
class NativeStreamingResponder implements IStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;

  private readonly stream: SlackTurnStream;
  private readonly tracker = new TaskTracker();
  private readonly gate = new DetailsGate();
  /** When false, reasoning bursts are not surfaced as Thinking cards. */
  private readonly reasoningCards: boolean;

  /** All raw answer-role text (incl. any details section) — engine fallback. */
  private fullText = '';
  /** Raw text since the last tool/reasoning boundary — the presumptive answer. */
  private lastTextRun = '';
  /** Unreleased text of the current run (narration until proven otherwise). */
  private runBuffer = '';
  /** True once the current run was released to the body and streams live. */
  private runReleased = false;
  private finished = false;

  /** ts the streaming reaction was placed on, if any. */
  private reactionTs: string | null = null;
  /** The in-flight reaction `add`, awaited before the `remove` so they can't race. */
  private reactionAdd: Promise<void> = Promise.resolve();

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
    this.reasoningCards = options.collapseWorkingNotes;

    this.stream = new SlackTurnStream(client, channel, threadTs, {
      recipientTeamId: options.recipientTeamId,
      recipientUserId: options.recipientUserId,
      onStart: () => this.addStreamReaction(this.stream.ts),
    });
    // Open eagerly with the plan-box title and a Thinking card — the stream
    // itself is the instant "working on it" feedback (no separate placeholder
    // message needed).
    this.stream.start([{ type: 'plan_update', title: WORK_LOG_TITLE }, this.tracker.seed()]);
  }

  onReasoningDelta(text: string): void {
    if (this.finished || text.length === 0) return;
    this.demoteBufferedRun();
    if (!this.reasoningCards) return;
    const chunk = this.tracker.onReasoningDelta(text);
    if (chunk) this.stream.appendTask(chunk);
  }

  onTextDelta(text: string): void {
    if (this.finished || text.length === 0) return;
    this.fullText += text;
    this.lastTextRun += text;
    if (!this.reasoningCards) {
      // Classification off: text runs stream straight to the body.
      const boundary = this.tracker.boundary();
      if (boundary) this.stream.appendTask(boundary);
      this.emitVisible(text);
      return;
    }
    if (this.runReleased) {
      this.emitVisible(text);
      return;
    }
    this.runBuffer += text;
    if (this.runBuffer.length > NARRATION_HOLDBACK_MAX_CHARS) this.releaseRun();
  }

  onToolEvent(event: ToolEventPayload): void {
    if (this.finished) return;
    this.demoteBufferedRun();
    for (const chunk of this.tracker.onToolEvent(event)) {
      this.stream.appendTask(chunk);
    }
  }

  private emitVisible(text: string): void {
    const visible = this.gate.push(text);
    if (visible) this.stream.appendMarkdown(visible);
  }

  /** The buffered run outgrew the narration holdback — it is the answer. */
  private releaseRun(): void {
    for (const chunk of this.tracker.answerBoundary()) {
      this.stream.appendTask(chunk);
    }
    this.emitVisible(this.runBuffer);
    this.runBuffer = '';
    this.runReleased = true;
  }

  /**
   * A tool/reasoning event ends the current text run. A run still held in the
   * buffer was narration, not the answer — surface it as a completed work-log
   * card instead of body text. A run already released to the body stays there
   * (streamed markdown can't be retracted; over-cap narration is rare).
   */
  private demoteBufferedRun(): void {
    if (this.runBuffer.trim().length > 0) {
      for (const chunk of this.tracker.narration(this.runBuffer)) {
        this.stream.appendTask(chunk);
      }
    }
    this.runBuffer = '';
    this.runReleased = false;
    this.lastTextRun = '';
  }

  /**
   * Add the streaming reaction once the stream message exists. Removed in
   * {@link finish}. Best effort.
   */
  private addStreamReaction(ts: string | null): void {
    if (!ts || this.reactionTs) return;
    this.reactionTs = ts;
    this.reactionAdd = safeReact(this.client, this.channel, ts, ANSWER_STREAMING_REACTION);
  }

  async finish(outcome?: StreamOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const ok = outcome?.ok !== false;

    // A run still buffered at end of turn is the answer — release it now, then
    // resolve any text held back by the details gate.
    let tailText = '';
    if (!this.runReleased && this.runBuffer.length > 0) {
      tailText += this.gate.push(this.runBuffer);
      this.runBuffer = '';
    }
    tailText += this.gate.finish().tail;
    const tailChunks = tailText ? [{ type: 'markdown_text' as const, text: tailText }] : [];
    const closeChunks = this.tracker.closeAll(ok ? 'complete' : 'error', outcome?.errorMessage);

    await this.stream.stop({ chunks: [...tailChunks, ...closeChunks] });

    // Streaming done — drop the reaction from the (now-finalized) message. Await
    // the add first so a fast finish can't remove before the add lands.
    if (this.reactionTs) {
      await this.reactionAdd;
      await safeReact(
        this.client,
        this.channel,
        this.reactionTs,
        ANSWER_STREAMING_REACTION,
        'remove',
      );
    }
  }

  getFullText(): string {
    return this.fullText;
  }

  /** Raw text of the final run (nothing streamed after it) — the live answer. */
  getLastTextRun(): string {
    return this.lastTextRun;
  }

  /** ts of the turn's stream message, if it ever opened. */
  getStreamTs(): string | null {
    return this.stream.ts;
  }

  /** True only if the stream message exists and was not finalized early by Slack. */
  streamDeliveredOk(): boolean {
    return this.stream.deliveredOk;
  }

  /** Rebuilt work-log blocks (plan + task cards) for the broken-stream path. */
  getTaskBlocks() {
    return this.tracker.toBlocks();
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
    await deliverText(this.client, {
      channel: this.channelId,
      threadTs: this.threadTs,
      text,
    });
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

  async onStreamComplete(
    finalText: string,
    responder: IStreamingResponder,
    opts?: { authoritative?: boolean },
  ): Promise<void> {
    if (this.responseMode === 'stream-native') {
      const nsr = responder as NativeStreamingResponder;
      const clean = finalText.trim();

      // When the engine fell back to the accumulated live text (no `result`
      // event — killed/timed-out turn), the streamed body IS the delivery:
      // rebuilding from it would only re-deliver narration-dirty text. Only
      // meaningful while the stream survived — a broken stream showed less than
      // the accumulated text, so even fallback text must be redelivered.
      const isFallback = !(opts?.authoritative ?? true);

      // The live message already shows the answer when its final text run
      // matches Claude's authoritative `result` text. A mismatch means the
      // answer got lost/garbled live (e.g. a late tool event followed the real
      // answer) — rebuild the message from `result` with the work-log cards on
      // top. A details section streamed inline (visible while live) and is
      // folded into a collapsed container by the same rebuild once the turn
      // ends. Oversized responses always take the file-upload path.
      const answerAlreadyLive =
        normalizeForCompare(stripDetailsForCompare(nsr.getLastTextRun())) ===
        normalizeForCompare(stripDetailsForCompare(finalText));
      const hasDetails = splitDetails(finalText).details !== null;
      const needsRebuild =
        clean.length > 0 &&
        (finalText.length > FILE_THRESHOLD ||
          !nsr.streamDeliveredOk() ||
          (!isFallback && (!answerAlreadyLive || hasDetails)));

      if (needsRebuild) {
        await deliverText(this.client, {
          channel: this.channelId,
          threadTs: this.threadTs,
          text: finalText,
          replaceTs: nsr.getStreamTs(),
          replaceBlocksPrefix: nsr.getTaskBlocks(),
        });
        return;
      }

      // Live message stands. An empty-answer turn keeps its message — it holds
      // the work-log cards.
      return;
    }

    // stream-update mode: the streamed plain message is already correct unless
    // the response is oversized or holds a details marker (folded by rewriting
    // the bubble through the block layout).
    const sr = responder as StreamingResponder;
    if (
      finalText.length > FILE_THRESHOLD ||
      finalText.length > MAX_MESSAGE_LENGTH ||
      splitDetails(finalText).details !== null
    ) {
      await deliverText(this.client, {
        channel: this.channelId,
        threadTs: this.threadTs,
        text: finalText,
        replaceTs: sr.getMessageTs(),
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

/** Whitespace-insensitive comparison key for live-vs-result answer text. */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Details are withheld from the wire, so compare only the pre-marker body. */
function stripDetailsForCompare(text: string): string {
  return splitDetails(text).body;
}
