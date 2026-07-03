import {
  ownerMention,
  listUserChannels,
  unauthorizedChannelMessage,
  unconfiguredChannelMessage,
  channelWelcomeMessage,
  dmWelcomeMessage,
  helpMessage,
} from '../adapters/slack/onboarding.js';
import type { Config } from '../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botOwners: ['U0OWNER'],
    permissions: { git: {}, jiraWrite: {} },
    users: { alice: { slack: 'U0ALICE' } },
    channels: {
      C0OPEN: { name: 'open-chan', folder: '/p' },
      C0MEMBERS: { name: 'members-chan', folder: '/p', members: ['alice'] },
      'voice-default': { name: 'voice', folder: '/p', members: ['alice'] },
    },
    defaults: { model: 'opus', systemPrompt: 's', timeoutMs: 1000, responseMode: 'batch' },
    ...overrides,
  };
}

describe('ownerMention', () => {
  it('mentions the owner, falls back to generic text', () => {
    expect(ownerMention(makeConfig())).toBe('<@U0OWNER>');
    expect(ownerMention(makeConfig({ botOwners: undefined }))).toBe('the bot owner');
    expect(ownerMention(makeConfig({ botOwners: ['U0A', 'U0B'] }))).toBe('<@U0A> or <@U0B>');
    // Registry-key entries resolve to the person's Slack id
    expect(ownerMention(makeConfig({ botOwners: ['alice'] }))).toBe('<@U0ALICE>');
  });
});

describe('listUserChannels', () => {
  it('lists open channels + membership channels, excluding voice pseudo-channels', () => {
    const config = makeConfig();
    expect(listUserChannels(config, 'U0ALICE').sort()).toEqual(['C0MEMBERS', 'C0OPEN']);
    expect(listUserChannels(config, 'U0STRANGER')).toEqual(['C0OPEN']);
  });
});

describe('message builders', () => {
  it('unauthorized message points at the owner', () => {
    const text = unauthorizedChannelMessage(makeConfig());
    expect(text).toContain('<@U0OWNER>');
    expect(text).toContain('!whoami');
  });

  it('unconfigured message introduces the bot and points at the owner', () => {
    const text = unconfiguredChannelMessage(makeConfig());
    expect(text).toContain("isn't configured");
    expect(text).toContain('<@U0OWNER>');
  });

  it('channel welcome mentions the repo and trigger mode', () => {
    const config = makeConfig({
      channels: {
        C0MENTION: { name: 'c', repo: 'my-repo', triggerMode: 'mention' },
      },
      repos: { 'my-repo': { url: 'https://x/y.git' } },
    });
    const text = channelWelcomeMessage(config, 'C0MENTION');
    expect(text).toContain('`my-repo`');
    expect(text).toContain('Mention me');
    // Unconfigured channel falls back to the unconfigured copy
    expect(channelWelcomeMessage(config, 'C0UNKNOWN')).toContain("isn't configured");
  });

  it('DM welcome lists the channels the user can access', () => {
    const config = makeConfig();
    const text = dmWelcomeMessage(config, 'U0ALICE');
    expect(text).toContain('<#C0OPEN>');
    expect(text).toContain('<#C0MEMBERS>');
  });

  it('DM welcome tells access-less users who to ask', () => {
    const config = makeConfig({
      channels: { C0MEMBERS: { name: 'c', folder: '/p', members: ['alice'] } },
    });
    const text = dmWelcomeMessage(config, 'U0STRANGER');
    expect(text).toContain("don't have access");
    expect(text).toContain('<@U0OWNER>');
  });

  it('DM welcome always includes the creds hint (enrollment is mandatory)', () => {
    // The DM welcome is already inside the DM — "right here", no DM link needed
    expect(dmWelcomeMessage(makeConfig(), 'U0ALICE')).toContain('Send `!creds` right here');
  });

  it('help adapts to configured channel / DM / unconfigured channel', () => {
    const config = makeConfig({
      channels: { C0CH: { name: 'c', repo: 'r', triggerMode: 'mention' } },
      repos: { r: { url: 'https://x/y.git' } },
    });
    expect(helpMessage(config, 'C0CH')).toContain('`r`');
    expect(helpMessage(config, 'C0CH')).toContain('mention me');
    expect(helpMessage(config, 'D0DM')).toContain('!whoami');
    expect(helpMessage(config, 'D0DM')).toContain('!creds');
    expect(helpMessage(config, 'D0DM')).toContain(
      'ask questions in one of your configured channels',
    );
    expect(helpMessage(config, 'C0UNKNOWN')).toContain("isn't configured");
    // command list always present
    const help = helpMessage(config, 'C0CH');
    expect(help).toContain('!whoami');
    expect(help).toContain('!creds list');
    expect(help).toContain('!creds revoke <name>|all');
    expect(help).toContain('!creds list @user');
  });
});
