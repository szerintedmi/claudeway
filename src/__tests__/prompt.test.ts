import { shouldRespond, buildCredentialStatus } from '../prompt.js';
import { setBotIdentity } from '../creds-hint.js';
import type { CredentialStatus } from '../credentials.js';

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
