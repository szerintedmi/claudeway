import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { ChatStreamer } from '@slack/web-api';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  type ResponseMode,
} from './config.js';
import {
  runClaude,
  runClaudeStreaming,
  runClaudePersistentStreaming,
  type ToolEventPayload,
} from './claude.js';
import {
  enqueue,
  dequeue,
  updateQueuedText,
  getPendingForChannel,
  type QueuedMessage,
} from './queue.js';
import { handleMagicCommand } from './commands.js';
import { isUserAllowed, safeReact, warnInThread } from './slack-utils.js';
import { shouldRespond, stripBotMention, buildPrompt } from './prompt.js';
import { fetchThreadContext } from './thread.js';
import { resolvedTempDir } from './config.js';
import { createRequestTempDir, uploadAttachedFiles, cleanupRequestTempDir } from './tempdir.js';

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

interface SlackMessage {
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
  deleted_ts?: string;
  message?: { ts?: string; text?: string };
}

const FILE_SIZE_LIMIT = 25 * 1024 * 1024; // 25MB
export const FILE_TEMP_BASE = resolve(process.cwd(), '.files');

interface DownloadResult {
  paths: string[];
  failedCount: number;
  totalCount: number;
}

async function downloadSlackFiles(
  files: SlackFile[],
  token: string,
  channelId: string,
): Promise<DownloadResult> {
  const downloadable = files.filter((f) => f.url_private_download && f.size <= FILE_SIZE_LIMIT);
  if (downloadable.length === 0) return { paths: [], failedCount: 0, totalCount: 0 };

  const dir = join(FILE_TEMP_BASE, channelId);
  mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  let failedCount = 0;
  for (const file of downloadable) {
    try {
      const res = await fetch(file.url_private_download!, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`[files] Failed to download ${file.name}: HTTP ${res.status}`);
        failedCount++;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const localPath = join(dir, `${file.id}-${file.name}`);
      writeFileSync(localPath, buffer);
      paths.push(localPath);
      console.log(`[files] Downloaded ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error(`[files] Failed to download ${file.name}:`, err);
      failedCount++;
    }
  }
  return { paths, failedCount, totalCount: downloadable.length };
}

// Re-export shared utilities for backward compatibility
export { isUserAllowed, safeReact } from './slack-utils.js';

const MAX_MESSAGE_LENGTH = 3900;
const FILE_THRESHOLD = 12000;

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Claude Code outputs standard Markdown by default; this ensures it renders
 * correctly in Slack even if the system prompt hint is ignored.
 *
 * Code blocks are extracted first and only have their language tag stripped —
 * all other conversions run only on non-code segments.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Split on fenced code blocks so conversions don't mangle code content.
  const parts: string[] = [];
  const codeBlockRe = /```\w*\n[\s\S]*?```/g;
  let lastIndex = 0;

  for (const match of text.matchAll(codeBlockRe)) {
    if (match.index > lastIndex) {
      parts.push(convertMarkdownText(text.slice(lastIndex, match.index)));
    }
    // Code blocks: only strip language tag, leave content untouched
    parts.push(match[0].replace(/^```\w+\n/, '```\n'));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(convertMarkdownText(text.slice(lastIndex)));
  }

  return parts.join('');
}

/**
 * Apply Markdown-to-mrkdwn conversions to a non-code-block text segment.
 */
function convertMarkdownText(text: string): string {
  let result = text;

  // Escape & and < before creating Slack tokens so Claude's literal text
  // (e.g. "x < y" or "AT&T") isn't misparsed by Slack as tokens/entities.
  // Link conversion below intentionally introduces < chars for Slack link tokens.
  result = result.replace(/&/g, '&amp;');
  result = result.replace(/</g, '&lt;');

  // Convert Markdown links [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headings (### text → *text*) — Slack has no heading syntax
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert **bold** → *bold* (must come before single-asterisk handling)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules (---, ***, ___) → ———
  result = result.replace(/^(?:[-*_]){3,}\s*$/gm, '———');

  // Convert Markdown bullet points (- item / * item) → • item
  result = result.replace(/^[*-] (.+)$/gm, '• $1');

  return result;
}

const STREAM_UPDATE_INTERVAL_MS = 500;
const STREAMING_INDICATOR = ' :writing_hand:';

const TOOL_DISPLAY_VERBS: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Bash: 'Running',
  Glob: 'Searching files',
  Grep: 'Searching',
  LS: 'Listing',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  Agent: 'Delegating to agent',
  Task: 'Delegating',
};

function formatToolStatus(toolName: string, keyArg: string | null): string {
  const verb = TOOL_DISPLAY_VERBS[toolName] ?? `Using ${toolName}`;
  if (keyArg) {
    return `:thinking_face: _${verb} \`${keyArg}\`..._`;
  }
  return `:thinking_face: _${verb}..._`;
}

class StreamingResponder {
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

class NativeStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientTeamId?: string;
  private recipientUserId?: string;
  private streamer: ChatStreamer | null = null;
  private fullText = '';
  private thinkingTs: string | null;
  private statusTs: string | null = null;
  private finished = false;
  private appendChain: Promise<void> = Promise.resolve();
  private toolEventChain: Promise<void> = Promise.resolve();

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
    if (!this.streamer && !this.finished) {
      // Use buffer_size: 1 so the stream message appears immediately on first delta
      this.streamer = this.client.chatStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        buffer_size: 1,
        ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
        ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
      });
      // Delete the status/thinking message now that the real stream has started
      if (this.statusTs) {
        const ts = this.statusTs;
        this.statusTs = null;
        this.client.chat.delete({ channel: this.channel, ts }).catch(() => {});
      } else if (this.thinkingTs) {
        const ts = this.thinkingTs;
        this.thinkingTs = null;
        this.client.chat.delete({ channel: this.channel, ts }).catch(() => {});
      }
      // Feed the accumulated text as the first append
      this.appendChain = this.appendChain
        .then(async () => {
          await this.streamer!.append({ markdown_text: text });
        })
        .catch((err) => {
          console.error('[native-stream] Failed to append initial text:', err);
        });
    } else if (this.streamer) {
      this.appendChain = this.appendChain
        .then(async () => {
          await this.streamer!.append({ markdown_text: text });
        })
        .catch((err) => {
          console.error('[native-stream] Failed to append text:', err);
        });
    }
  }

  async finish(): Promise<void> {
    this.finished = true;
    // Clean up thinking/status message if stream never started (empty response)
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
    if (this.streamer) {
      try {
        await this.appendChain;
        await this.streamer.stop();
      } catch (err) {
        console.error('[native-stream] Failed to stop stream:', err);
      }
    }
  }

  getFullText(): string {
    return this.fullText;
  }
}

// Per-channel processing lock — one message at a time per channel
const channelBusy = new Set<string>();

// Messages currently being processed (file still on disk but data already in memory)
const processingMessages = new Set<string>();
const processingKey = (channelId: string, ts: string) => `${channelId}_${ts}`;

// Global concurrency limit for Claude CLI processes
export const MAX_CONCURRENT_PROCESSES = 8;
let activeProcesses = 0;
const concurrencyWaiters: (() => void)[] = [];

async function acquireProcessSlot(): Promise<void> {
  if (activeProcesses < MAX_CONCURRENT_PROCESSES) {
    activeProcesses++;
    return;
  }
  await new Promise<void>((resolve) => concurrencyWaiters.push(resolve));
  activeProcesses++;
}

function releaseProcessSlot(): void {
  activeProcesses--;
  const next = concurrencyWaiters.shift();
  if (next) next();
}

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
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

async function processBatch(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
  tempDir: string,
): Promise<void> {
  try {
    const result = await runClaude({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      threadTs: queued.threadTs,
      filePaths: queued.filePaths,
      tempDir,
    });

    await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    await sendResponse(client, queued.channelId, queued.threadTs, result.response);

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    // Files are kept for session resume; cleaned up by startup sweep
  }
}

async function processStreamUpdate(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
  tempDir: string,
): Promise<void> {
  try {
    const responder = new StreamingResponder(client, queued.channelId, queued.threadTs);

    const result = await runClaudeStreaming({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      threadTs: queued.threadTs,
      filePaths: queued.filePaths,
      tempDir,
      onTextDelta: (text) => responder.onTextDelta(text),
      onToolEvent: (event) => responder.onToolEvent(event),
    });

    await responder.finish();

    await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    // If final response exceeds file threshold, upload as file and delete the streamed message
    const finalText = result.response || responder.getFullText();
    if (finalText.length > FILE_THRESHOLD) {
      // Delete the streamed message and upload as file instead
      const msgTs = responder.getMessageTs();
      if (msgTs) {
        try {
          await client.chat.delete({ channel: queued.channelId, ts: msgTs });
        } catch {
          // Best effort — may lack permission
        }
      }
      await client.files.uploadV2({
        channel_id: queued.channelId,
        thread_ts: queued.threadTs,
        content: finalText,
        filename: 'response.md',
        title: 'Response',
      });
    } else if (finalText.length > MAX_MESSAGE_LENGTH) {
      // Final text fits in messages but was truncated during streaming — do a final complete send
      const formatted = markdownToSlackMrkdwn(finalText);
      const chunks = splitMessage(formatted);
      // Update the existing message with the first chunk
      const msgTs = responder.getMessageTs();
      if (msgTs && chunks.length > 0) {
        try {
          await client.chat.update({
            channel: queued.channelId,
            ts: msgTs,
            text: chunks[0],
          });
        } catch {
          // Fall through to post
        }
        // Post remaining chunks as follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await client.chat.postMessage({
            channel: queued.channelId,
            thread_ts: queued.threadTs,
            text: chunks[i],
          });
        }
      }
    }

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    // Files are kept for session resume; cleaned up by startup sweep
  }
}

async function processStreamNative(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
  tempDir: string,
): Promise<void> {
  try {
    // Post a draft thinking message for immediate visual feedback while Claude processes
    let thinkingTs: string | undefined;
    try {
      const res = await client.chat.postMessage({
        channel: queued.channelId,
        thread_ts: queued.threadTs,
        text: ':thinking_face: _thinking..._',
      });
      thinkingTs = res.ts ?? undefined;
    } catch {
      // Non-critical — proceed without thinking preview
    }

    const responder = new NativeStreamingResponder(client, queued.channelId, queued.threadTs, {
      thinkingTs,
      recipientTeamId: queued.teamId,
      recipientUserId: queued.userId,
    });

    const result = await runClaudeStreaming({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      threadTs: queued.threadTs,
      filePaths: queued.filePaths,
      tempDir,
      onTextDelta: (text) => responder.onTextDelta(text),
      onToolEvent: (event) => responder.onToolEvent(event),
    });

    await responder.finish();

    await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    // Native streaming handles display automatically; fall back to file upload for huge responses
    const finalText = result.response || responder.getFullText();
    if (finalText.length > FILE_THRESHOLD) {
      await client.files.uploadV2({
        channel_id: queued.channelId,
        thread_ts: queued.threadTs,
        content: finalText,
        filename: 'response.md',
        title: 'Response',
      });
    }

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    // Files are kept for session resume; cleaned up by startup sweep
  }
}

async function processPersistent(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
  tempDir: string,
  tempBaseDir: string,
): Promise<void> {
  const mode = channelConfig.responseMode;

  if (mode === 'batch') {
    // No streaming output needed — use a no-op delta handler
    try {
      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        tempBaseDir,
        onTextDelta: () => {},
      });

      await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');
      await sendResponse(client, queued.channelId, queued.threadTs, result.response);

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      // Files are kept for session resume; cleaned up by startup sweep
    }
  } else if (mode === 'stream-update') {
    try {
      const responder = new StreamingResponder(client, queued.channelId, queued.threadTs);

      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        tempBaseDir,
        onTextDelta: (text) => responder.onTextDelta(text),
        onToolEvent: (event) => responder.onToolEvent(event),
      });

      await responder.finish();
      await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

      const finalText = result.response || responder.getFullText();
      if (finalText.length > FILE_THRESHOLD) {
        const msgTs = responder.getMessageTs();
        if (msgTs) {
          try {
            await client.chat.delete({ channel: queued.channelId, ts: msgTs });
          } catch {
            // Best effort
          }
        }
        await client.files.uploadV2({
          channel_id: queued.channelId,
          thread_ts: queued.threadTs,
          content: finalText,
          filename: 'response.md',
          title: 'Response',
        });
      } else if (finalText.length > MAX_MESSAGE_LENGTH) {
        const formatted = markdownToSlackMrkdwn(finalText);
        const chunks = splitMessage(formatted);
        const msgTs = responder.getMessageTs();
        if (msgTs && chunks.length > 0) {
          try {
            await client.chat.update({ channel: queued.channelId, ts: msgTs, text: chunks[0] });
          } catch {
            // Fall through
          }
          for (let i = 1; i < chunks.length; i++) {
            await client.chat.postMessage({
              channel: queued.channelId,
              thread_ts: queued.threadTs,
              text: chunks[i],
            });
          }
        }
      }

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      // Files are kept for session resume; cleaned up by startup sweep
    }
  } else {
    // stream-native
    try {
      let thinkingTs: string | undefined;
      try {
        const res = await client.chat.postMessage({
          channel: queued.channelId,
          thread_ts: queued.threadTs,
          text: ':thinking_face: _thinking..._',
        });
        thinkingTs = res.ts ?? undefined;
      } catch {
        // Non-critical
      }

      const responder = new NativeStreamingResponder(client, queued.channelId, queued.threadTs, {
        thinkingTs,
        recipientTeamId: queued.teamId,
        recipientUserId: queued.userId,
      });

      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        tempBaseDir,
        onTextDelta: (text) => responder.onTextDelta(text),
        onToolEvent: (event) => responder.onToolEvent(event),
      });

      await responder.finish();
      await safeReact(client, queued.channelId, queued.ts, 'ballot_box_with_check');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

      const finalText = result.response || responder.getFullText();
      if (finalText.length > FILE_THRESHOLD) {
        await client.files.uploadV2({
          channel_id: queued.channelId,
          thread_ts: queued.threadTs,
          content: finalText,
          filename: 'response.md',
          title: 'Response',
        });
      }

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      // Files are kept for session resume; cleaned up by startup sweep
    }
  }
}

const MODE_PROCESSORS: Record<
  ResponseMode,
  (
    queued: QueuedMessage,
    client: WebClient,
    config: ReturnType<typeof resolvedChannelConfig> & object,
    tempDir: string,
  ) => Promise<void>
> = {
  batch: processBatch,
  'stream-update': processStreamUpdate,
  'stream-native': processStreamNative,
};

async function processQueuedMessage(queued: QueuedMessage, client: WebClient): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err);
    await warnInThread(
      client,
      queued.channelId,
      queued.threadTs,
      'Failed to load config — message skipped. Check server logs.',
    );
    dequeue(queued.channelId, queued.ts);
    return;
  }

  const resolvedCh = resolvedChannelConfig(config, queued.channelId);
  const channelConfig = resolvedCh
    ? resolvedCh
    : queued.channelId.startsWith('D') && config.botOwner
      ? resolvedDmConfig(config)
      : null;
  if (!channelConfig) {
    dequeue(queued.channelId, queued.ts);
    return;
  }

  processingMessages.add(processingKey(queued.channelId, queued.ts));
  await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand');
  await safeReact(client, queued.channelId, queued.ts, 'inbox_tray', 'remove');

  const mode = channelConfig.responseMode;

  // Wait for a process slot if at global concurrency limit
  if (activeProcesses >= MAX_CONCURRENT_PROCESSES) {
    console.log(
      `[${channelConfig.name}] Waiting for process slot (${activeProcesses}/${MAX_CONCURRENT_PROCESSES} active)`,
    );
  }
  await acquireProcessSlot();

  const processMode = channelConfig.processMode;
  console.log(
    `[${channelConfig.name}] Processing (${processMode}/${mode}): ${queued.text.substring(0, 80)}...`,
  );

  const baseDir = resolvedTempDir(config);
  const tempDir = createRequestTempDir(baseDir, queued.channelId);

  try {
    if (processMode === 'persistent') {
      await processPersistent(queued, client, channelConfig, tempDir, baseDir);
    } else {
      await MODE_PROCESSORS[mode](queued, client, channelConfig, tempDir);
    }
  } catch (err) {
    await safeReact(client, queued.channelId, queued.ts, 'x');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${channelConfig.name}] Error:`, errorMsg);

    try {
      await client.chat.postMessage({
        channel: queued.channelId,
        thread_ts: queued.threadTs,
        text: `:warning: Error: ${errorMsg}`,
      });
    } catch (replyErr) {
      console.error(`[${channelConfig.name}] Failed to send error reply:`, replyErr);
    }
  } finally {
    // Upload any files Claude attached, then clean up (runs on both success and error)
    await uploadAttachedFiles(tempDir, client, queued.channelId, queued.threadTs);
    cleanupRequestTempDir(tempDir, baseDir, queued.channelId);
  }

  // Remove from persistent queue after processing (success or error)
  dequeue(queued.channelId, queued.ts);
  processingMessages.delete(processingKey(queued.channelId, queued.ts));
  releaseProcessSlot();
}

async function drainChannel(channelId: string, client: WebClient): Promise<void> {
  channelBusy.add(channelId);

  try {
    let pending = getPendingForChannel(channelId);
    while (pending.length > 0) {
      await processQueuedMessage(pending[0], client);
      pending = getPendingForChannel(channelId);
    }
  } finally {
    channelBusy.delete(channelId);
  }
}

export function registerMessageHandler(app: App, botUserId: string): void {
  app.message(async ({ message, client, context }) => {
    const msg = message as SlackMessage;

    // Ignore bot messages and message edits (allow file_share for file attachments)
    if (msg.bot_id) return;
    if (
      msg.subtype &&
      msg.subtype !== 'file_share' &&
      msg.subtype !== 'message_deleted' &&
      msg.subtype !== 'message_changed' &&
      msg.subtype !== 'thread_broadcast'
    )
      return;

    // Handle message deletions — remove from queue if still pending
    if (msg.subtype === 'message_deleted' && msg.deleted_ts) {
      const removed = dequeue(msg.channel, msg.deleted_ts);
      if (removed) {
        console.log(
          `[${msg.channel}] Message deleted from Slack — removed from queue: ${msg.deleted_ts}`,
        );
      }
      return;
    }

    // Handle message edits — update queue content if still pending (not yet processing)
    if (msg.subtype === 'message_changed' && msg.message?.ts && msg.message?.text) {
      const origTs = msg.message.ts;
      if (!processingMessages.has(processingKey(msg.channel, origTs))) {
        const updated = updateQueuedText(
          msg.channel,
          origTs,
          stripBotMention(msg.message.text, botUserId),
        );
        if (updated) {
          console.log(`[${msg.channel}] Queued message edited — updated in queue: ${origTs}`);
        }
      }
      return;
    }

    // Handle magic commands (!ps, !kill, !killall) — bypass queue and Claude processing
    if (
      msg.text &&
      msg.user &&
      (await handleMagicCommand(
        msg.text,
        msg.channel,
        msg.thread_ts ?? msg.ts,
        msg.ts,
        msg.user,
        client,
      ))
    ) {
      return;
    }

    const hasText = !!msg.text;
    const hasFiles = !!(msg.files && msg.files.some((f) => f.url_private_download));
    // Require at least text or files
    if (!hasText && !hasFiles) return;

    // Quick config check + user authorization
    let channelAllowedUsers: string[] | undefined;
    let triggerMode: import('./config.js').TriggerMode = 'all';
    try {
      const config = loadConfig();
      const resolved = resolvedChannelConfig(config, msg.channel);
      if (!resolved) {
        if (msg.channel.startsWith('D')) {
          if (msg.user !== config.botOwner) {
            await safeReact(client, msg.channel, msg.ts, 'no_entry');
            await client.chat.postMessage({
              channel: msg.channel,
              thread_ts: msg.thread_ts ?? msg.ts,
              text: 'Sorry, DMs are not enabled for your account.',
            });
            return;
          }
          // botOwner DM — allow through (triggerMode stays 'all')
        } else {
          return;
        }
      } else {
        triggerMode = resolved.triggerMode;
        channelAllowedUsers = resolved.allowedUsers;
      }
    } catch (err) {
      console.error('Failed to load config during message routing:', err);
      await safeReact(client, msg.channel, msg.ts, 'warning');
      await warnInThread(
        client,
        msg.channel,
        msg.thread_ts ?? msg.ts,
        'Failed to load config — message not processed. Check server logs.',
      );
      return;
    }

    // Trigger mode check — in 'mention' mode, ignore messages without @bot
    // File-only messages (no text) bypass the mention requirement
    if (!shouldRespond(msg.text, botUserId, triggerMode) && !hasFiles) return;

    // Reject unauthorized users
    const userId = msg.user ?? 'unknown';
    if (!isUserAllowed(channelAllowedUsers, userId)) {
      await safeReact(client, msg.channel, msg.ts, 'no_entry');
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.thread_ts ?? msg.ts,
        text: "Sorry, you're not authorized to use this bot in this channel.",
      });
      return;
    }

    // Download file attachments before enqueueing
    let filePaths: string[] = [];
    if (hasFiles && msg.files) {
      const token = context.botToken ?? process.env.SLACK_BOT_TOKEN ?? '';
      const result = await downloadSlackFiles(msg.files, token, msg.channel);
      filePaths = result.paths;
      if (result.failedCount > 0) {
        const threadTs = msg.thread_ts ?? msg.ts;
        await warnInThread(
          client,
          msg.channel,
          threadTs,
          `Failed to download ${result.failedCount} of ${result.totalCount} file(s). Check server logs.`,
        );
      }
    }

    // If files were expected but all exceeded the size limit, and there's no text — abort
    if (!msg.text && hasFiles && filePaths.length === 0) return;

    // Fetch thread context if this is a thread reply
    const threadTs = msg.thread_ts ?? msg.ts;
    const isThreadReply = !!(msg.thread_ts && msg.thread_ts !== msg.ts);
    const threadMessages = isThreadReply
      ? await fetchThreadContext(client, msg.channel, msg.thread_ts!, msg.ts, botUserId)
      : [];

    // Build final prompt: strip bot mentions and prepend thread context
    const rawText = msg.text || (filePaths.length > 0 ? 'Please review the attached file(s).' : '');
    const text = buildPrompt(rawText, botUserId, threadMessages);
    const teamId = context.teamId;

    // Persist to queue
    enqueue({
      channelId: msg.channel,
      userId: msg.user ?? 'unknown',
      ...(teamId ? { teamId } : {}),
      text,
      ts: msg.ts,
      threadTs,
      queuedAt: new Date().toISOString(),
      ...(filePaths.length > 0 ? { filePaths } : {}),
    });

    // Acknowledge receipt immediately
    await safeReact(client, msg.channel, msg.ts, 'inbox_tray');

    if (channelBusy.has(msg.channel)) {
      console.log(`[${msg.channel}] Busy, message queued`);
      return;
    }

    drainChannel(msg.channel, client).catch((err) => {
      console.error(`[${msg.channel}] Queue drain error:`, err);
    });
  });
}

/**
 * Process any messages left in the queue from before a restart.
 * Call after Bolt app.start() with the Slack client.
 */
export function drainAllPending(app: App): void {
  // Drain pending messages for all channels after a short delay
  setTimeout(async () => {
    const { getPending } = await import('./queue.js');
    const pending = getPending();
    if (pending.length === 0) return;

    console.log(`[startup] Found ${pending.length} queued message(s) from before restart`);

    const channels = [...new Set(pending.map((m) => m.channelId))];
    for (const channelId of channels) {
      if (channelBusy.has(channelId)) continue;
      // Use the app's web client
      const client = app.client;
      drainChannel(channelId, client).catch((err) => {
        console.error(`[${channelId}] Startup drain error:`, err);
      });
    }
  }, 3000);
}
