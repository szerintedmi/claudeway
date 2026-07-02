import type { WebClient } from '@slack/web-api';
import {
  loadConfig,
  resolvedChannelConfig,
  isUserAllowedInChannel,
  isBotOwner,
  resolveUser,
  resolveCanonicalUserId,
  type Config,
} from '../../config.js';
import { getActiveProcesses, killProcess, killAllProcesses, nudgeProcess } from '../../claude.js';
import { getPending } from '../../queue.js';
import { safeReact, warnInThread } from './utils.js';
import { MAX_CONCURRENT_PROCESSES } from '../../core/engine.js';
import { botDmTarget, helpMessage, listUserChannels, ownerMention } from './onboarding.js';
import { getSecretStore } from '../../secrets.js';

// --- Types ---

/** 'open' commands are informational and available to anyone, anywhere (incl. DMs). */
type CommandScope = 'global' | 'channel' | 'open';

interface CommandDef {
  name: string;
  scope: CommandScope;
  hasChannelArg?: boolean;
  handler: (ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
  channelId: string;
  targetChannelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  client: WebClient;
  config: Config;
  botUserId?: string;
}

// --- Helpers ---

function getChannelName(channelId: string): string {
  try {
    const config = loadConfig();
    return config.channels[channelId]?.name ?? channelId;
  } catch {
    return channelId;
  }
}

function findChannelIdByName(name: string): string | null {
  try {
    const config = loadConfig();
    for (const [id, ch] of Object.entries(config.channels)) {
      if (ch.name === name) return id;
    }
  } catch {
    // Config error
  }
  return null;
}

export function formatDuration(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTimeout(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

export function formatChannelConfig(
  channelId: string,
  resolved: {
    folder: string;
    model: string;
    responseMode: string;
    processMode: string;
    timeoutMs: number;
    triggerMode?: string;
    collapseWorkingNotes?: boolean;
  },
): string {
  const lines = [
    `<#${channelId}>`,
    `\u2022 Folder: \`${resolved.folder}\``,
    `\u2022 Model: \`${resolved.model}\``,
    `\u2022 Mode: \`${resolved.responseMode}\` / \`${resolved.processMode}\``,
    `\u2022 Trigger: \`${resolved.triggerMode ?? 'all'}\``,
    `\u2022 Timeout: ${formatTimeout(resolved.timeoutMs)}`,
  ];
  if (resolved.responseMode === 'stream-native') {
    lines.push(`\u2022 Collapse work log: \`${resolved.collapseWorkingNotes !== false}\``);
  }
  return lines.join('\n');
}

function isMagicCommandAllowed(
  config: Config,
  userId: string,
  channelId: string,
  scope: CommandScope,
): boolean {
  if (scope === 'open') return true;
  if (isBotOwner(config, userId)) return true;
  if (scope === 'global') return false;
  // DMs are botOwners-only (magic commands run before the DM gate);
  // the sole exception is !creds, which is dispatched before this check
  if (channelId.startsWith('D')) return false;
  return isUserAllowedInChannel(config, channelId, userId);
}

async function denyMagicCommand(
  channelId: string,
  messageTs: string,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  await safeReact(client, channelId, messageTs, 'no_entry');
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "Sorry, you're not authorized to run this command.",
  });
}

// --- Command handlers ---

async function psHandler(ctx: CommandContext): Promise<void> {
  const { channelId, userId, config, client, threadTs } = ctx;
  const filterChannelId = isBotOwner(config, userId) ? undefined : channelId;

  const allProcesses = getActiveProcesses();
  const processes = filterChannelId
    ? allProcesses.filter((p) => p.channelId === filterChannelId)
    : allProcesses;
  const allPending = getPending();
  const pending = filterChannelId
    ? allPending.filter((p) => p.channelId === filterChannelId)
    : allPending;

  let text: string;
  if (processes.length === 0) {
    text = ':gear: *No active processes*';
  } else {
    const lines = processes.map((p) => {
      const name = getChannelName(p.channelId);
      const duration = formatDuration(p.startedAt);
      const snippet = p.message.length > 80 ? p.message.substring(0, 80) + '...' : p.message;
      const msgs =
        p.messageCount > 0 ? ` \u2014 ${p.messageCount} msg${p.messageCount !== 1 ? 's' : ''}` : '';
      const stats =
        p.totalTokens > 0
          ? ` \u2014 ${p.totalTokens.toLocaleString()} tokens`
          : p.totalCost > 0
            ? ` \u2014 $${p.totalCost.toFixed(4)}`
            : '';
      const status = p.isActive ? ' :hourglass_flowing_sand:' : ' (idle)';
      return `\u2022 #${name} \u2014 ${duration}${msgs}${stats} \u2014 "${snippet}"${status}`;
    });
    text = `:gear: *Active Processes (${processes.length}/${MAX_CONCURRENT_PROCESSES})*\n\n${lines.join('\n')}`;
  }

  if (pending.length > 0) {
    const channelCounts = new Map<string, number>();
    for (const msg of pending) {
      const name = getChannelName(msg.channelId);
      channelCounts.set(name, (channelCounts.get(name) ?? 0) + 1);
    }
    const breakdown = Array.from(channelCounts.entries())
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    text += `\n\nQueued: ${pending.length} message${pending.length !== 1 ? 's' : ''} (${breakdown})`;
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
}

async function killHandler(ctx: CommandContext): Promise<void> {
  const { channelId, targetChannelId, threadTs, client } = ctx;
  const processes = getActiveProcesses();
  const target = processes.find((p) => p.channelId === targetChannelId);

  if (!target) {
    const name = getChannelName(targetChannelId);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: No active process in #${name}`,
    });
    return;
  }

  const name = getChannelName(targetChannelId);
  const duration = formatDuration(target.startedAt);
  const killed = killProcess(targetChannelId);

  if (killed) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:stop_sign: Killed process in #${name} (was running ${duration})`,
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: Failed to kill process in #${name}`,
    });
  }
}

async function killAllHandler(ctx: CommandContext): Promise<void> {
  const { channelId, threadTs, client } = ctx;
  const processes = getActiveProcesses();
  if (processes.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':stop_sign: No active processes to kill',
    });
    return;
  }

  const killed = killAllProcesses();
  const names = killed.map((id) => `#${getChannelName(id)}`).join(', ');
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `:stop_sign: Killed ${killed.length} process${killed.length !== 1 ? 'es' : ''}: ${names}`,
  });
}

async function nudgeHandler(ctx: CommandContext): Promise<void> {
  const { channelId, targetChannelId, threadTs, client } = ctx;
  const processes = getActiveProcesses();
  const target = processes.find((p) => p.channelId === targetChannelId);

  if (!target) {
    const name = getChannelName(targetChannelId);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: No active process in #${name}`,
    });
    return;
  }

  const name = getChannelName(targetChannelId);
  const nudged = nudgeProcess(targetChannelId);
  if (nudged) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:bell: Nudged #${name} (sent SIGINT \u2014 process may wrap up or continue)`,
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: Failed to nudge process in #${name}`,
    });
  }
}

async function configHandler(ctx: CommandContext): Promise<void> {
  const { channelId, threadTs, client, config } = ctx;
  const resolved = resolvedChannelConfig(config, channelId);

  let text: string;
  if (resolved) {
    text = `:gear: *Channel Configuration*\n\n${formatChannelConfig(channelId, resolved)}`;
  } else {
    const entries = Object.entries(config.channels);
    if (entries.length === 0) {
      text = ':gear: *No channels configured*';
    } else {
      const lines = entries.map(([id]) => {
        const r = resolvedChannelConfig(config, id)!;
        return formatChannelConfig(id, r);
      });
      text = `:gear: *Claudeway Configuration*\n${entries.length} channel${entries.length !== 1 ? 's' : ''} configured\n\n${lines.join('\n\n')}`;
    }
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
}

async function helpHandler(ctx: CommandContext): Promise<void> {
  const { channelId, threadTs, client, config } = ctx;
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: helpMessage(config, channelId),
  });
}

async function whoamiHandler(ctx: CommandContext): Promise<void> {
  const { channelId, threadTs, userId, client, config, botUserId } = ctx;
  const user = resolveUser(config, channelId, userId);
  const lines = [':bust_in_silhouette: *Your access*'];

  lines.push(
    `• Identity: <@${userId}>${user.registered ? ` → \`${user.userId}\`` : ' (not in the user registry)'}${user.isBotOwner ? ' — bot owner' : ''}`,
  );

  const channels = listUserChannels(config, userId);
  lines.push(
    `• Channels: ${channels.length > 0 ? channels.map((id) => `<#${id}>`).join(', ') : 'none yet'}`,
  );

  if (config.channels[channelId]) {
    const allowed = isUserAllowedInChannel(config, channelId, userId) || user.isBotOwner;
    const perms = [...user.permissions].sort();
    lines.push(
      `• This channel: ${allowed ? `allowed — ${perms.length > 0 ? perms.join(', ') : 'read-only'}` : 'not a member'}`,
    );
  }

  if (config.userCredentials && Object.keys(config.userCredentials).length > 0) {
    const store = getSecretStore();
    const names = store ? store.listNames(resolveCanonicalUserId(config, userId)) : [];
    lines.push(
      `• Credentials: ${
        names.length > 0
          ? names.map((n) => `\`${n}\``).join(', ')
          : `none — DM ${botDmTarget(botUserId)} \`!creds\` to connect your own`
      }`,
    );
  }

  lines.push(`Need more access? Ask ${ownerMention(config)}.`);
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: lines.join('\n'),
  });
}

// --- Registry ---

const commands: CommandDef[] = [
  { name: 'config', scope: 'global', handler: configHandler },
  { name: 'ps', scope: 'channel', handler: psHandler },
  { name: 'kill', scope: 'channel', hasChannelArg: true, handler: killHandler },
  { name: 'killall', scope: 'global', handler: killAllHandler },
  { name: 'nudge', scope: 'channel', hasChannelArg: true, handler: nudgeHandler },
  { name: 'help', scope: 'open', handler: helpHandler },
  { name: 'whoami', scope: 'open', handler: whoamiHandler },
];

// --- Dispatcher ---

/**
 * Parse and dispatch a magic command (e.g., "!kill", "!kill #channel").
 * Returns true if the text matched a command (even if denied), false otherwise.
 */
export async function handleMagicCommand(
  text: string,
  channelId: string,
  threadTs: string,
  messageTs: string,
  userId: string,
  client: WebClient,
  botUserId?: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return false;

  // `!creds` has its own multi-arg grammar and its own auth (any allowed user,
  // DM-only) — handled before the single-arg command regex below
  if (trimmed === '!creds' || trimmed.startsWith('!creds ')) {
    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      console.error('Failed to load config in !creds command:', err);
      await warnInThread(client, channelId, threadTs, 'Failed to load config. Check server logs.');
      return true;
    }
    const { handleCredsCommand } = await import('./creds-command.js');
    return handleCredsCommand(trimmed, channelId, threadTs, userId, client, config, botUserId);
  }

  // Parse: "!cmd" or "!cmd <#C123|name>" or "!cmd #name" or "!cmd name"
  const match = trimmed.match(/^!(\S+)(?:\s+(?:<#(\w+)(?:\|[^>]*)?>|#?(\S+)))?$/);
  if (!match) return false;

  const cmdName = match[1];
  const slackChannelId = match[2]; // from <#C123|name> format
  const targetName = match[3]; // from #name or bare name format
  const hasArg = !!(slackChannelId || targetName);

  const def = commands.find((c) => c.name === cmdName);
  if (!def) return false;

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config in magic command:', err);
    await warnInThread(client, channelId, threadTs, 'Failed to load config. Check server logs.');
    return true;
  }

  // Resolve target channel for commands with channel args
  let targetChannelId = channelId;
  let effectiveScope = def.scope;

  if (hasArg) {
    if (!def.hasChannelArg) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:warning: \`!${cmdName}\` does not accept a channel argument`,
      });
      return true;
    }

    // Channel arg elevates to global scope
    effectiveScope = 'global';

    if (slackChannelId) {
      targetChannelId = slackChannelId;
    } else if (targetName) {
      const resolved = findChannelIdByName(targetName);
      if (!resolved) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:warning: No configured channel named "${targetName}"`,
        });
        return true;
      }
      targetChannelId = resolved;
    }
  }

  // Auth check
  if (!isMagicCommandAllowed(config, userId, channelId, effectiveScope)) {
    await denyMagicCommand(channelId, messageTs, threadTs, client);
    return true;
  }

  await def.handler({
    channelId,
    targetChannelId,
    threadTs,
    messageTs,
    userId,
    client,
    config,
    botUserId,
  });

  return true;
}
