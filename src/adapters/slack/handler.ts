import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  type AllowedUserEntry,
  type TriggerMode,
} from '../../config.js';
import { enqueue, dequeue, updateQueuedMessage, getPending } from '../../queue.js';
import { handleMagicCommand } from './commands.js';
import { isUserAllowed, safeReact, warnInThread } from './utils.js';
import { shouldRespond, buildPrompt, extractMentionedUserIds } from '../../prompt.js';
import { fetchThreadContext, resolveUserName } from './thread.js';
import { extractTextFromAttachments, type SlackAttachment } from './attachments.js';
import { downloadSlackFiles, type SlackFile } from './files.js';
import { SlackChannelResponder } from './responder.js';
import { drainChannel, channelBusy, isMessageProcessing } from '../../core/engine.js';
import type { QueuedMessage } from '../../queue.js';

function makeResponder(client: WebClient, queued: QueuedMessage): SlackChannelResponder {
  const cfg = loadConfig();
  const resolved = resolvedChannelConfig(cfg, queued.channelId) ?? resolvedDmConfig(cfg);
  return new SlackChannelResponder(
    client,
    queued.channelId,
    queued.threadTs,
    queued.ts,
    resolved.responseMode,
    queued.userId,
    queued.teamId,
  );
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
  attachments?: SlackAttachment[];
}

/**
 * Resolve user IDs to display names for the user directory.
 * Always includes `alwaysInclude` IDs (e.g. bot, sender) plus any
 * `<@U...>` mentions found in the given texts.
 */
export async function resolveUserDirectory(
  client: WebClient,
  alwaysInclude: string[],
  ...texts: string[]
): Promise<Array<{ id: string; name: string }>> {
  const mentioned = extractMentionedUserIds(...texts);
  const allIds = [...new Set([...alwaysInclude, ...mentioned])];
  if (allIds.length === 0) return [];
  const names = await Promise.all(allIds.map((id) => resolveUserName(client, id)));
  return allIds.map((id, i) => ({ id, name: names[i] }));
}

// Per-turn model override: "!model:<name> <message>". First char must be alphanumeric
// so option-like values (e.g. `--verbose`) can't become CLI args; spawn() arg arrays
// already prevent shell injection.
const MODEL_OVERRIDE_RE = /^\s*!model:([A-Za-z0-9][\w.\-[\]:]*)(?:\s+([\s\S]*))?$/;

export function parseModelOverride(text: string): { model: string; rest: string } | null {
  const m = text.match(MODEL_OVERRIDE_RE);
  if (!m) return null;
  return { model: m[1], rest: (m[2] ?? '').trim() };
}

/**
 * Strip a leading `!model:<name>` token (after any bot mention) from message text.
 * Keeps the mention prefix so shouldRespond() still sees it in mention-trigger channels.
 */
export function applyModelOverride(
  text: string,
  botUserId: string,
): { text: string; modelOverride?: string } {
  const mentionPrefix = text.match(new RegExp(`^\\s*<@${botUserId}>\\s*`))?.[0] ?? '';
  const override = parseModelOverride(text.slice(mentionPrefix.length));
  if (!override) return { text };
  return { text: mentionPrefix + override.rest, modelOverride: override.model };
}

export function registerMessageHandler(app: App, botUserId: string, canResolveUsers = true): void {
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
      if (!isMessageProcessing(msg.channel, origTs)) {
        // Re-parse the model override so edits can add, change, or remove it
        const applied = applyModelOverride(msg.message.text, botUserId);
        const updated = updateQueuedMessage(msg.channel, origTs, {
          text: applied.text,
          modelOverride: applied.modelOverride,
        });
        if (updated) {
          console.log(`[${msg.channel}] Queued message edited — updated in queue: ${origTs}`);
        }
      }
      return;
    }

    // Handle magic commands (!ps, !kill, !killall) — bypass queue and Claude processing
    // Strip bot mention prefix so commands work in mention-trigger channels (e.g. "@bot !nudge")
    const magicText = msg.text?.replace(new RegExp(`^\\s*<@${botUserId}>\\s*`), '') ?? '';
    if (
      magicText &&
      msg.user &&
      (await handleMagicCommand(
        magicText,
        msg.channel,
        msg.thread_ts ?? msg.ts,
        msg.ts,
        msg.user,
        client,
      ))
    ) {
      return;
    }

    // Per-turn model override — strip the "!model:<name>" token, keep the mention
    let modelOverride: string | undefined;
    if (msg.text) {
      const applied = applyModelOverride(msg.text, botUserId);
      msg.text = applied.text;
      modelOverride = applied.modelOverride;
    }

    const attachmentText = extractTextFromAttachments(msg.attachments);
    // Collect files from both top-level msg.files and inside shared-message attachments
    const attachmentFiles: SlackFile[] = (msg.attachments ?? [])
      .flatMap((a) => a.files ?? [])
      .filter((f) => f.id && f.name)
      .map((f) => ({
        id: f.id!,
        name: f.name!,
        mimetype: f.mimetype ?? '',
        size: f.size ?? 0,
        url_private_download: f.url_private_download,
      }));
    const allFiles: SlackFile[] = [...(msg.files ?? []), ...attachmentFiles];
    const hasText = !!(msg.text || attachmentText);
    const hasFiles = allFiles.some((f) => f.url_private_download);
    // Model override with no prompt body (and nothing else to act on) — usage hint
    if (modelOverride && !hasFiles && !attachmentText) {
      const bodyText = msg.text?.replace(new RegExp(`^\\s*<@${botUserId}>\\s*`), '').trim();
      if (!bodyText) {
        await warnInThread(
          client,
          msg.channel,
          msg.thread_ts ?? msg.ts,
          'Usage: `!model:<name> <message>` — add a prompt after the model override.',
        );
        return;
      }
    }
    // Require at least text or files
    if (!hasText && !hasFiles) return;

    // Quick config check + user authorization
    let channelAllowedUsers: AllowedUserEntry[] | undefined;
    let triggerMode: TriggerMode = 'all';
    let botOwner: string | undefined;
    try {
      const config = loadConfig();
      botOwner = config.botOwner;
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
    // Check both direct text and attachment text (shared/forwarded messages)
    const combinedText = [msg.text, attachmentText].filter(Boolean).join('\n');
    if (!shouldRespond(combinedText || undefined, botUserId, triggerMode)) return;

    // Reject unauthorized users (botOwner always allowed)
    const userId = msg.user ?? 'unknown';
    if (userId !== botOwner && !isUserAllowed(channelAllowedUsers, userId)) {
      await safeReact(client, msg.channel, msg.ts, 'no_entry');
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.thread_ts ?? msg.ts,
        text: "Sorry, you're not authorized to use this bot in this channel.",
      });
      return;
    }

    // Download file attachments before enqueueing (includes files from shared messages)
    let filePaths: string[] = [];
    if (hasFiles) {
      const token = context.botToken ?? process.env.SLACK_BOT_TOKEN ?? '';
      const result = await downloadSlackFiles(allFiles, token, msg.channel);
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
    if (!hasText && hasFiles && filePaths.length === 0) return;

    // Fetch thread context if this is a thread reply
    const threadTs = msg.thread_ts ?? msg.ts;
    const isThreadReply = !!(msg.thread_ts && msg.thread_ts !== msg.ts);
    const threadMessages = isThreadReply
      ? await fetchThreadContext(
          client,
          msg.channel,
          msg.thread_ts!,
          msg.ts,
          botUserId,
          canResolveUsers,
        )
      : [];

    const rawText =
      [msg.text, attachmentText].filter(Boolean).join('\n\n') ||
      (filePaths.length > 0 ? 'Please review the attached file(s).' : '');

    // Build a user directory so the bot knows who <@UXXXXXX> mentions refer to
    // Always include the bot and the message sender, plus any mentioned users
    const allTexts = [...threadMessages.map((m) => m.text), rawText];
    const userDirectory = canResolveUsers
      ? await resolveUserDirectory(client, [botUserId, userId], ...allTexts)
      : [];
    const text = buildPrompt(rawText, threadMessages, userDirectory, botUserId);
    const teamId = context.teamId;
    const senderEntry = userDirectory.find((e) => e.id === userId);

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
      ...(senderEntry ? { userName: senderEntry.name } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    });

    // Acknowledge receipt immediately
    await safeReact(client, msg.channel, msg.ts, 'inbox_tray');

    if (channelBusy.has(msg.channel)) {
      console.log(`[${msg.channel}] Busy, message queued`);
      return;
    }

    drainChannel(msg.channel, (queued) => makeResponder(client, queued)).catch((err) => {
      console.error(`[${msg.channel}] Queue drain error:`, err);
    });
  });
}

/**
 * Process any messages left in the queue from before a restart.
 * Call after Bolt app.start() with the Slack App.
 */
export function drainAllPending(app: App): void {
  // Drain pending messages for all channels after a short delay
  setTimeout(async () => {
    const pending = getPending();
    if (pending.length === 0) return;

    // Discard non-Slack messages (e.g. voice) — the WebSocket is gone after restart
    const discarded: string[] = [];
    const slackPending = pending.filter((m) => {
      if (m.adapter && m.adapter !== 'slack') {
        dequeue(m.channelId, m.ts);
        discarded.push(m.adapter);
        return false;
      }
      return true;
    });
    if (discarded.length > 0) {
      console.log(
        `[startup] Discarded ${discarded.length} non-Slack queued message(s) (${[...new Set(discarded)].join(', ')})`,
      );
    }

    if (slackPending.length === 0) return;

    console.log(`[startup] Found ${slackPending.length} queued message(s) from before restart`);

    const channels = [...new Set(slackPending.map((m) => m.channelId))];
    for (const channelId of channels) {
      if (channelBusy.has(channelId)) continue;
      const client = app.client;
      drainChannel(channelId, (queued) => makeResponder(client, queued)).catch((err) => {
        console.error(`[${channelId}] Startup drain error:`, err);
      });
    }
  }, 3000);
}
