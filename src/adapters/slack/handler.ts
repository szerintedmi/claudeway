import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  isUserAllowedInChannel,
  isBotOwner,
  EFFORT_LEVELS,
  isEffortLevel,
  type EffortLevel,
  type TriggerMode,
} from '../../config.js';
import { enqueue, dequeue, updateQueuedMessage, getPending } from '../../queue.js';
import { handleMagicCommand } from './commands.js';
import { safeReact, warnInThread } from './utils.js';
import {
  channelWelcomeMessage,
  dmWelcomeMessage,
  unauthorizedChannelMessage,
  unconfiguredChannelMessage,
} from './onboarding.js';
import { shouldRespond } from '../../prompt.js';
import { resolveUserName } from './thread.js';
import { extractTextFromAttachments, type SlackAttachment } from './attachments.js';
import { type SlackFile } from './files.js';
import { SlackChannelResponder } from './responder.js';
import { makeSlackPromptCoordinator } from './coordinator.js';
import { drainChannel, channelBusy, isMessageProcessing } from '../../core/engine.js';
import type { QueuedMessage, SlackFileMeta } from '../../queue.js';

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
    resolved.collapseWorkingNotes,
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
  // message_changed events carry thread_ts on the inner message, not the envelope
  message?: { ts?: string; text?: string; thread_ts?: string };
  attachments?: SlackAttachment[];
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

// Per-turn effort override: "!effort:<level> <message>". The token is captured freeform
// (alphanumeric first char so it can't become a CLI flag) and validated against
// EFFORT_LEVELS in the handler — so an unknown value is reported, not silently ignored.
const EFFORT_OVERRIDE_RE = /^\s*!effort:([A-Za-z0-9][\w.-]*)(?:\s+([\s\S]*))?$/;

export function parseEffortOverride(text: string): { effort: string; rest: string } | null {
  const m = text.match(EFFORT_OVERRIDE_RE);
  if (!m) return null;
  return { effort: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

const unknownEffortWarning = (effort: string): string =>
  `Unknown effort '${effort}'. Valid: ${EFFORT_LEVELS.join(', ')}.`;

/**
 * Strip leading `!model:<name>` / `!effort:<level>` tokens (in any order, after any bot
 * mention) from message text. Keeps the mention prefix so shouldRespond() still sees it in
 * mention-trigger channels. The effort value is returned freeform; the caller validates it.
 */
export function applyOverrides(
  text: string,
  botUserId: string,
): { text: string; modelOverride?: string; effortOverride?: string } {
  const mentionPrefix = text.match(new RegExp(`^\\s*<@${botUserId}>\\s*`))?.[0] ?? '';
  let rest = text.slice(mentionPrefix.length);
  let modelOverride: string | undefined;
  let effortOverride: string | undefined;
  for (;;) {
    const m = parseModelOverride(rest);
    if (m && modelOverride === undefined) {
      modelOverride = m.model;
      rest = m.rest;
      continue;
    }
    const e = parseEffortOverride(rest);
    if (e && effortOverride === undefined) {
      effortOverride = e.effort;
      rest = e.rest;
      continue;
    }
    break;
  }
  return { text: mentionPrefix + rest, modelOverride, effortOverride };
}

// Channels already greeted/hinted this process run (welcome + unconfigured hint)
const welcomedChannels = new Set<string>();
const unconfiguredHinted = new Set<string>();

export function registerMessageHandler(app: App, botUserId: string, canResolveUsers = true): void {
  // Fallback join detection — fires only if the app manifest subscribes to
  // member_joined_channel; the channel_join message path below covers the rest.
  app.event('member_joined_channel', async ({ event, client }) => {
    if (event.user !== botUserId || welcomedChannels.has(event.channel)) return;
    welcomedChannels.add(event.channel);
    try {
      const config = loadConfig();
      await client.chat.postMessage({
        channel: event.channel,
        text: channelWelcomeMessage(config, event.channel),
      });
    } catch (err) {
      console.error(`[${event.channel}] Failed to post welcome:`, err);
    }
  });

  app.message(async ({ message, client, context }) => {
    const msg = message as SlackMessage;

    // Welcome message when the bot itself is added to a channel (the join shows
    // up as a channel_join system message for the bot's own user)
    if (msg.subtype === 'channel_join' && msg.user === botUserId) {
      if (!welcomedChannels.has(msg.channel)) {
        welcomedChannels.add(msg.channel);
        try {
          const config = loadConfig();
          await client.chat.postMessage({
            channel: msg.channel,
            text: channelWelcomeMessage(config, msg.channel),
          });
        } catch (err) {
          console.error(`[${msg.channel}] Failed to post welcome:`, err);
        }
      }
      return;
    }

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
        // Re-parse overrides so edits can add, change, or remove them
        const applied = applyOverrides(msg.message.text, botUserId);
        // On an invalid effort, still apply the rest of the edit (text/model) — discarding
        // the whole edit would silently run the stale pre-edit prompt
        const effortOverride =
          applied.effortOverride && isEffortLevel(applied.effortOverride)
            ? applied.effortOverride
            : undefined;
        const updated = updateQueuedMessage(msg.channel, origTs, {
          text: applied.text,
          modelOverride: applied.modelOverride,
          effortOverride,
        });
        if (updated) {
          console.log(`[${msg.channel}] Queued message edited — updated in queue: ${origTs}`);
          // Warn only when the edit affected a still-queued message — edits of
          // already-processed (or never-queued) messages stay silent no-ops. Queued
          // messages have already passed the config/trigger/authorization gates.
          if (applied.effortOverride && !effortOverride) {
            await warnInThread(
              client,
              msg.channel,
              msg.message.thread_ts ?? msg.thread_ts ?? origTs,
              `${unknownEffortWarning(applied.effortOverride)} Edit applied without the effort override.`,
            );
          }
        }
      }
      return;
    }

    // Per-turn overrides — strip the "!model:<name>" / "!effort:<level>" tokens, keep the
    // mention. Stripped BEFORE the magic-command check so an override prefix can't swallow
    // a magic command into a Claude prompt (e.g. "!effort:high !kill" still kills).
    // Validation feedback is deferred until after the config/trigger/authorization gates.
    let modelOverride: string | undefined;
    let effortOverride: EffortLevel | undefined;
    let rawEffortOverride: string | undefined;
    if (msg.text) {
      const applied = applyOverrides(msg.text, botUserId);
      msg.text = applied.text;
      modelOverride = applied.modelOverride;
      rawEffortOverride = applied.effortOverride;
      if (rawEffortOverride && isEffortLevel(rawEffortOverride)) {
        effortOverride = rawEffortOverride;
      }
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
        botUserId,
      ))
    ) {
      return;
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
    // Override with no prompt body (and nothing else to act on) — usage hint, deferred
    // until after the gates below so the bot never replies where it would stay silent
    const bareOverride =
      !!(modelOverride || rawEffortOverride) && !hasFiles && !attachmentText && !magicText.trim();
    // Require at least text or files (a bare override falls through for the usage hint)
    if (!hasText && !hasFiles && !bareOverride) return;

    // Quick config check + user authorization
    let userAllowedInChannel = true;
    let triggerMode: TriggerMode = 'all';
    let senderIsOwner: boolean;
    try {
      const config = loadConfig();
      senderIsOwner = isBotOwner(config, msg.user ?? '');
      const resolved = resolvedChannelConfig(config, msg.channel);
      if (!resolved) {
        if (msg.channel.startsWith('D')) {
          if (!senderIsOwner) {
            // Friendly DM welcome instead of a flat rejection — tells the user
            // what the bot is, where they can use it, and how to get access
            await client.chat.postMessage({
              channel: msg.channel,
              thread_ts: msg.thread_ts ?? msg.ts,
              text: dmWelcomeMessage(config, msg.user ?? 'unknown'),
            });
            return;
          }
          // botOwner DM — allow through (triggerMode stays 'all')
        } else {
          // Unconfigured channel: stay silent for ambient traffic, but answer an
          // explicit @mention once per channel so the bot isn't confusingly mute
          if (msg.text?.includes(`<@${botUserId}>`) && !unconfiguredHinted.has(msg.channel)) {
            unconfiguredHinted.add(msg.channel);
            await client.chat.postMessage({
              channel: msg.channel,
              thread_ts: msg.thread_ts ?? msg.ts,
              text: unconfiguredChannelMessage(config),
            });
          }
          return;
        }
      } else {
        triggerMode = resolved.triggerMode;
        // Registry-aware: channel `members` (canonical users)
        userAllowedInChannel = isUserAllowedInChannel(config, msg.channel, msg.user ?? 'unknown');
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

    // Reject unauthorized users (botOwners always allowed) — with a pointer to
    // who can grant access instead of a bare refusal
    const userId = msg.user ?? 'unknown';
    if (!senderIsOwner && !userAllowedInChannel) {
      await safeReact(client, msg.channel, msg.ts, 'no_entry');
      const config = loadConfig();
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.thread_ts ?? msg.ts,
        text: unauthorizedChannelMessage(config),
      });
      return;
    }

    // Validate the effort override against the known set — block + hint on an unknown value
    // (the CLI silently runs at the default effort otherwise, with no thread feedback)
    if (rawEffortOverride && !effortOverride) {
      await warnInThread(
        client,
        msg.channel,
        msg.thread_ts ?? msg.ts,
        unknownEffortWarning(rawEffortOverride),
      );
      return;
    }
    if (bareOverride) {
      await warnInThread(
        client,
        msg.channel,
        msg.thread_ts ?? msg.ts,
        'Usage: `!model:<name>` / `!effort:<level>` — add a prompt after the override(s).',
      );
      return;
    }

    // Downloads are DEFERRED to processing time (D10): the resolved session
    // isn't known here (config is hot-reloaded again in the engine, so a
    // folder/repo change while the message is queued would move the session),
    // and files for messages edited/deleted/killed before processing shouldn't
    // be downloaded at all. The coordinator downloads from `downloadRef` into
    // the resolved session's incoming/.
    const threadTs = msg.thread_ts ?? msg.ts;

    const rawText =
      [msg.text, attachmentText].filter(Boolean).join('\n\n') ||
      (hasFiles ? 'Please review the attached file(s).' : '');

    // Current-message attachment metadata. downloadRef (url_private_download) is
    // kept SERVER-SIDE on the queue entry only — never in the prompt or env.
    const fileMetas: SlackFileMeta[] = allFiles.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.mimetype ? { mimetype: f.mimetype } : {}),
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.url_private_download ? { downloadRef: f.url_private_download } : {}),
    }));

    // Sender + bot identity for the message prefix / new-session header. History
    // is NOT fetched here — the coordinator renders it at processing time.
    const senderName = canResolveUsers ? await resolveUserName(client, userId) : undefined;
    const botName = canResolveUsers ? await resolveUserName(client, botUserId) : undefined;
    const teamId = context.teamId;

    // Persist to queue (structured: prompt rendered at processing time)
    enqueue({
      channelId: msg.channel,
      userId: msg.user ?? 'unknown',
      ...(teamId ? { teamId } : {}),
      text: rawText,
      ts: msg.ts,
      threadTs,
      botUserId,
      queuedAt: new Date().toISOString(),
      ...(senderName ? { userName: senderName } : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(effortOverride ? { effortOverride } : {}),
      slack: {
        rawText,
        senderId: userId,
        ...(senderName ? { senderName } : {}),
        botUserId,
        ...(botName ? { botName } : {}),
        ...(fileMetas.length > 0 ? { files: fileMetas } : {}),
      },
    });

    // Acknowledge receipt immediately
    await safeReact(client, msg.channel, msg.ts, 'inbox_tray');

    if (channelBusy.has(msg.channel)) {
      console.log(`[${msg.channel}] Busy, message queued`);
      return;
    }

    drainChannel(
      msg.channel,
      (queued) => makeResponder(client, queued),
      makeSlackPromptCoordinator(client, canResolveUsers),
    ).catch((err) => {
      console.error(`[${msg.channel}] Queue drain error:`, err);
    });
  });
}

/**
 * Process any messages left in the queue from before a restart.
 * Call after Bolt app.start() with the Slack App.
 */
export function drainAllPending(app: App, canResolveUsers = true): void {
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
      drainChannel(
        channelId,
        (queued) => makeResponder(client, queued),
        makeSlackPromptCoordinator(client, canResolveUsers),
      ).catch((err) => {
        console.error(`[${channelId}] Startup drain error:`, err);
      });
    }
  }, 3000);
}
