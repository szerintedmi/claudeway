import {
  shouldRespond,
  formatThreadContext,
  buildPrompt,
  buildCredentialStatus,
  extractMentionedUserIds,
  formatUserDirectory,
  type ThreadMessage,
} from '../prompt.js';
import { resolveUserDirectory } from '../adapters/slack/handler.js';
import { setBotIdentity } from '../creds-hint.js';
import type { CredentialStatus } from '../credentials.js';
import type { WebClient } from '@slack/web-api';

const BOT_ID = 'U_BOT';

describe('shouldRespond', () => {
  it('returns true in "all" mode regardless of mention', () => {
    expect(shouldRespond('hello world', BOT_ID, 'all')).toBe(true);
  });

  it('returns true in "all" mode even without text', () => {
    expect(shouldRespond(undefined, BOT_ID, 'all')).toBe(true);
  });

  it('returns true in "mention" mode when bot is mentioned', () => {
    expect(shouldRespond(`<@${BOT_ID}> help`, BOT_ID, 'mention')).toBe(true);
  });

  it('returns false in "mention" mode when bot is not mentioned', () => {
    expect(shouldRespond('help me', BOT_ID, 'mention')).toBe(false);
  });

  it('returns false in "mention" mode for undefined text', () => {
    expect(shouldRespond(undefined, BOT_ID, 'mention')).toBe(false);
  });
});

describe('formatThreadContext', () => {
  it('returns empty string for no messages', () => {
    expect(formatThreadContext([])).toBe('');
  });

  it('formats a single message with count', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'hello' }];
    const result = formatThreadContext(msgs);
    expect(result).toContain('[Thread context — 1 prior message]');
    expect(result).toContain('[Alice]: hello');
    expect(result).toContain('[Current message]');
  });

  it('formats multiple messages with plural count', () => {
    const msgs: ThreadMessage[] = [
      { authorName: 'Alice', isBot: false, text: 'question' },
      { authorName: 'Claude', isBot: true, text: 'answer' },
    ];
    const result = formatThreadContext(msgs);
    expect(result).toContain('[Thread context — 2 prior messages]');
    expect(result).toContain('[Alice]: question');
    expect(result).toContain('[Claude]: answer');
  });

  it('uses authorName directly (bot label handled upstream)', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Claude', isBot: true, text: 'hi' }];
    expect(formatThreadContext(msgs)).toContain('[Claude]: hi');
  });
});

describe('extractMentionedUserIds', () => {
  it('extracts a single mention', () => {
    expect(extractMentionedUserIds('hey <@U123>')).toEqual(['U123']);
  });

  it('extracts multiple unique mentions across texts', () => {
    const ids = extractMentionedUserIds('<@U123> hello', '<@U456> world');
    expect(ids).toContain('U123');
    expect(ids).toContain('U456');
    expect(ids).toHaveLength(2);
  });

  it('deduplicates mentions', () => {
    expect(extractMentionedUserIds('<@U123> and <@U123>')).toEqual(['U123']);
  });

  it('returns empty array when no mentions', () => {
    expect(extractMentionedUserIds('no mentions')).toEqual([]);
  });
});

describe('formatUserDirectory', () => {
  it('returns empty string for no entries', () => {
    expect(formatUserDirectory([])).toBe('');
  });

  it('formats entries as a lookup table', () => {
    const result = formatUserDirectory([
      { id: 'U123', name: 'Alice' },
      { id: 'U456', name: 'Bob' },
    ]);
    expect(result).toContain('[Slack user reference]');
    expect(result).toContain('<@U123> = Alice');
    expect(result).toContain('<@U456> = Bob');
  });

  it('annotates the bot entry with (you)', () => {
    const result = formatUserDirectory(
      [
        { id: 'U123', name: 'Alice' },
        { id: 'UBOT', name: 'CopilotBrain' },
      ],
      'UBOT',
    );
    expect(result).toContain('<@UBOT> = CopilotBrain (you)');
    expect(result).toContain('<@U123> = Alice');
    expect(result).not.toContain('Alice (you)');
  });
});

describe('resolveUserDirectory', () => {
  function mockClient(nameMap: Record<string, string>): WebClient {
    return {
      users: {
        info: async ({ user }: { user: string }) => ({
          user: { profile: { display_name_normalized: nameMap[user] ?? user } },
        }),
      },
    } as unknown as WebClient;
  }

  it('resolves mentions to directory entries', async () => {
    const client = mockClient({ U123: 'Alice', U456: 'Bob' });
    const entries = await resolveUserDirectory(client, [], '<@U123> and <@U456>');
    expect(entries).toEqual([
      { id: 'U123', name: 'Alice' },
      { id: 'U456', name: 'Bob' },
    ]);
  });

  it('always includes alwaysInclude IDs', async () => {
    const client = mockClient({ UBOT: 'CopilotBrain', USENDER: 'Alice' });
    const entries = await resolveUserDirectory(client, ['UBOT', 'USENDER'], 'no mentions');
    expect(entries).toEqual([
      { id: 'UBOT', name: 'CopilotBrain' },
      { id: 'USENDER', name: 'Alice' },
    ]);
  });

  it('deduplicates alwaysInclude with mentioned IDs', async () => {
    let callCount = 0;
    const client = {
      users: {
        info: async () => {
          callCount++;
          return { user: { profile: { display_name_normalized: 'Alice' } } };
        },
      },
    } as unknown as WebClient;
    const entries = await resolveUserDirectory(client, ['U123'], '<@U123> hi');
    expect(entries).toHaveLength(1);
    expect(callCount).toBeLessThanOrEqual(1);
  });

  it('returns empty array when no IDs at all', async () => {
    const client = mockClient({});
    expect(await resolveUserDirectory(client, [], 'no mentions')).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('returns text as-is when no thread context or directory', () => {
    expect(buildPrompt('hello', [])).toBe('hello');
  });

  it('prepends thread context before the user message', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'prior' }];
    const result = buildPrompt('follow up', msgs);
    expect(result.indexOf('Thread context')).toBeLessThan(result.indexOf('follow up'));
  });

  it('includes user directory before thread context', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'first' }];
    const dir = [{ id: 'U123', name: 'Alice' }];
    const result = buildPrompt('<@U123> second', msgs, dir);
    expect(result).toContain('[Slack user reference]');
    expect(result).toContain('<@U123> = Alice');
    expect(result.indexOf('Slack user reference')).toBeLessThan(result.indexOf('Thread context'));
    expect(result).toContain('<@U123> second');
  });

  it('keeps raw mentions in text unchanged', () => {
    const result = buildPrompt('<@U123> help me', []);
    expect(result).toContain('<@U123>');
  });
});

describe('buildCredentialStatus', () => {
  afterEach(() => setBotIdentity({}));

  const statuses: CredentialStatus[] = [
    { name: 'claude', label: 'Claude token', source: 'personal' },
    { name: 'jira', label: 'Jira', source: 'shared', note: 'read-only — Jira writes will fail' },
    { name: 'github', label: 'GitHub PAT', source: 'none' },
  ];

  it('returns empty when every credential resolved personally', () => {
    const allPersonal = statuses.map((s) => ({
      ...s,
      source: 'personal' as const,
      note: undefined,
    }));
    expect(buildCredentialStatus(allPersonal, '<@U1>')).toBe('');
    expect(buildCredentialStatus([], '<@U1>')).toBe('');
  });

  it('lists shared and missing credentials with their notes', () => {
    const block = buildCredentialStatus(statuses, '<@U1> (Peter)');
    expect(block).toContain('## Credential status for <@U1> (Peter)');
    expect(block).toContain(
      'jira (Jira): using the SHARED default token — read-only — Jira writes will fail',
    );
    expect(block).toContain('github (GitHub PAT): NO credential available');
    expect(block).not.toContain('claude');
  });

  it('tells the agent to refuse doomed operations and relay the enrollment path', () => {
    setBotIdentity({ botUserId: 'U0BOT' });
    const block = buildCredentialStatus(statuses, '<@U1>');
    expect(block).toContain('do NOT attempt it');
    expect(block).toContain('send `!creds` in a *direct message* to <@U0BOT>');
  });
});
