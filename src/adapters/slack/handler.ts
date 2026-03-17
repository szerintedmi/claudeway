import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  type AllowedUserEntry,
  type TriggerMode,
} from '../../config.js';
import { enqueue, dequeue, updateQueuedText, getPending } from '../../queue.js';
import { handleMagicCommand } from './commands.js';
import { isUserAllowed, safeReact, warnInThread } from './utils.js';
import { shouldRespond, buildPrompt, extractMentionedUserIds } from '../../prompt.js';
import { fetchThreadContext, resolveUserName } from './thread.js';
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
        const updated = updateQueuedText(msg.channel, origTs, msg.message.text);
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
    if (!shouldRespond(msg.text, botUserId, triggerMode)) return;

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
      ? await fetchThreadContext(
          client,
          msg.channel,
          msg.thread_ts!,
          msg.ts,
          botUserId,
          canResolveUsers,
        )
      : [];

    const rawText = msg.text || (filePaths.length > 0 ? 'Please review the attached file(s).' : '');

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

    console.log(`[startup] Found ${pending.length} queued message(s) from before restart`);

    const channels = [...new Set(pending.map((m) => m.channelId))];
    for (const channelId of channels) {
      if (channelBusy.has(channelId)) continue;
      const client = app.client;
      drainChannel(channelId, (queued) => makeResponder(client, queued)).catch((err) => {
        console.error(`[${channelId}] Startup drain error:`, err);
      });
    }
  }, 3000);
}
