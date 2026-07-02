import {
  botOwnerSlackIds,
  isUserAllowedInChannel,
  resolvedChannelConfig,
  type Config,
} from '../../config.js';

/**
 * Onboarding / help copy for unauthorized and new users. All text is DERIVED
 * from config (owner, channels, trigger mode) — no dedicated onboarding config.
 */

export function ownerMention(config: Config): string {
  const owners = botOwnerSlackIds(config);
  if (owners.length === 0) return 'the bot owner';
  return owners.map((id) => `<@${id}>`).join(' or ');
}

export function botDmTarget(botUserId?: string): string {
  return botUserId ? `<@${botUserId}>` : 'me';
}

/** Channels (excluding voice-only pseudo-channels) this user may use. */
export function listUserChannels(config: Config, userId: string): string[] {
  return Object.keys(config.channels)
    .filter((id) => id.startsWith('C')) // real Slack channels only
    .filter((id) => isUserAllowedInChannel(config, id, userId));
}

export function credsHint(botUserId?: string): string {
  return `DM ${botDmTarget(botUserId)} \`!creds\` to connect your own Claude/Jira/GitHub credentials.`;
}

/** Case 1: authorized channel, user not on the member list. */
export function unauthorizedChannelMessage(config: Config): string {
  return (
    `You're not on the member list for this channel yet. ` +
    `Ask ${ownerMention(config)} to add you — then just ask me anything here. ` +
    '`!whoami` shows your current access.'
  );
}

/** Case 2/3 (unconfigured): bot present but channel not in config. */
export function unconfiguredChannelMessage(config: Config): string {
  return (
    `:wave: I'm Claudeway — I run Claude Code against our repos. ` +
    `This channel isn't configured yet; ask ${ownerMention(config)} to add it to my config.`
  );
}

/** Case 3 (configured): welcome posted when the bot joins a configured channel. */
export function channelWelcomeMessage(config: Config, channelId: string): string {
  const resolved = resolvedChannelConfig(config, channelId);
  if (!resolved) return unconfiguredChannelMessage(config);
  const repo = config.channels[channelId]?.repo;
  const trigger =
    resolved.triggerMode === 'mention' ? 'Mention me to ask a question' : 'Just ask me anything';
  return (
    `:wave: I'm Claudeway — Claude Code over Slack${repo ? `, serving \`${repo}\` here` : ''}. ` +
    `${trigger}; I answer in a thread — reply there to continue the conversation. ` +
    '`!help` lists commands, `!whoami` shows your access.'
  );
}

/** Case 4: friendly DM response for non-owner users. */
export function dmWelcomeMessage(config: Config, userId: string, botUserId?: string): string {
  const channels = listUserChannels(config, userId);
  const lines = [
    ":wave: Hi! I'm Claudeway — I run Claude Code against our repos from Slack.",
    channels.length > 0
      ? `You can use me in: ${channels.map((id) => `<#${id}>`).join(', ')} — ask me anything there and I'll reply in a thread.`
      : `You don't have access to any of my channels yet — ask ${ownerMention(config)} to add you.`,
    '`!help` lists commands, `!whoami` shows your access.',
  ];
  lines.push(credsHint(botUserId));
  lines.push(`Ask questions in a configured channel; owner-only admin commands also work here.`);
  return lines.join('\n');
}

/** Case 6: `!help` — works anywhere, including DMs and unconfigured channels. */
export function helpMessage(config: Config, channelId: string): string {
  const resolved = resolvedChannelConfig(config, channelId);
  const lines = [':robot_face: *Claudeway* — Claude Code on our repos, via Slack.'];

  if (resolved) {
    const repo = config.channels[channelId]?.repo;
    const trigger =
      resolved.triggerMode === 'mention' ? 'mention me to ask' : 'just ask me anything';
    lines.push(
      `• This channel${repo ? ` serves \`${repo}\`` : ''} — ${trigger}. I reply in a thread; reply there to continue.`,
    );
  } else if (channelId.startsWith('D')) {
    lines.push(
      `• In DMs, \`!help\`, \`!whoami\`, and \`!creds\` are available; ask questions in one of your configured channels.`,
    );
  } else {
    lines.push(
      `• This channel isn't configured — ask ${ownerMention(config)} to add it to my config.`,
    );
  }

  lines.push('• Per-message overrides: start with `!model:<name>` and/or `!effort:<level>`.');
  const commands = [
    '`!whoami` (your access)',
    '`!ps` (running work)',
    '`!help`',
    '`!creds` / `!creds list` / `!creds revoke <name>|all` (in DM — manage your credentials)',
    '`!creds list @user` / `!creds revoke @user [name|all]` (bot owner)',
  ];
  lines.push(`• Commands: ${commands.join(', ')}.`);
  lines.push(`• Access questions: ask ${ownerMention(config)}.`);
  return lines.join('\n');
}
