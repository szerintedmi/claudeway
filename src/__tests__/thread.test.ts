import { beforeEach, describe, it, expect, spyOn } from 'bun:test';
import type { WebClient } from '@slack/web-api';
import {
  resetUserNameCache,
  resolveUserName,
  fetchThreadEntries,
} from '../adapters/slack/thread.js';

beforeEach(() => {
  resetUserNameCache();
  // Suppress expected console noise from error-path tests
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
});

function makeUserClient(displayName: string) {
  return {
    users: {
      info: async () => ({
        user: { profile: { display_name_normalized: displayName } },
      }),
    },
  } as unknown as WebClient;
}

function makeRepliesClient(messages: object[], capture?: { params?: Record<string, unknown> }) {
  return {
    users: {
      info: async ({ user }: { user: string }) => ({
        user: { profile: { display_name_normalized: user + '-display' } },
      }),
    },
    conversations: {
      replies: async (params: Record<string, unknown>) => {
        if (capture) capture.params = params;
        return { messages };
      },
    },
  } as unknown as WebClient;
}

describe('resolveUserName', () => {
  it('returns display_name_normalized from users.info', async () => {
    const name = await resolveUserName(makeUserClient('Alice'), 'U001');
    expect(name).toBe('Alice');
  });

  it('caches the result — second call does not invoke API', async () => {
    let callCount = 0;
    const client = {
      users: {
        info: async () => {
          callCount++;
          return { user: { profile: { display_name_normalized: 'Bob' } } };
        },
      },
    } as unknown as WebClient;
    await resolveUserName(client, 'U002');
    await resolveUserName(client, 'U002');
    expect(callCount).toBe(1);
  });

  it('falls back to userId on API error', async () => {
    const client = {
      users: {
        info: async () => {
          throw new Error('API error');
        },
      },
    } as unknown as WebClient;
    const name = await resolveUserName(client, 'U003');
    expect(name).toBe('U003');
  });

  it('caches the fallback too', async () => {
    let callCount = 0;
    const client = {
      users: {
        info: async () => {
          callCount++;
          throw new Error('fail');
        },
      },
    } as unknown as WebClient;
    await resolveUserName(client, 'U004');
    await resolveUserName(client, 'U004');
    expect(callCount).toBe(1);
  });
});

describe('fetchThreadEntries', () => {
  const OPTS = { botUserId: 'UBOT' };

  it('returns null when conversations.replies throws (caller degrades to no context)', async () => {
    const client = {
      users: { info: async () => ({}) },
      conversations: {
        replies: async () => {
          throw new Error('fail');
        },
      },
    } as unknown as WebClient;
    const result = await fetchThreadEntries(client, 'C1', '100', OPTS);
    expect(result).toBeNull();
  });

  it('returns ALL messages including the current one — selection is the coordinator’s job', async () => {
    const client = makeRepliesClient([
      { ts: '100', user: 'U1', text: 'first' },
      { ts: '200', user: 'U2', text: 'trigger' },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '100', OPTS);
    expect(result?.map((e) => e.ts)).toEqual(['100', '200']);
  });

  it('marks only OUR bot as isSelfBot; third-party bots stay isBot only', async () => {
    const client = makeRepliesClient([
      { ts: '100', bot_id: 'B1', user: 'UBOT', text: 'our bot' },
      { ts: '101', bot_id: 'B2', username: 'Jira', text: 'jira update' },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result?.[0].isSelfBot).toBe(true);
    expect(result?.[0].isBot).toBe(true);
    expect(result?.[1].isSelfBot).toBe(false);
    expect(result?.[1].isBot).toBe(true);
    expect(result?.[1].authorName).toBe('Jira');
    expect(result?.[1].userId).toBeUndefined();
  });

  it('resolves human display names and carries the user id', async () => {
    const client = makeRepliesClient([{ ts: '100', user: 'U1', text: 'hello' }]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result?.[0].authorName).toBe('U1-display');
    expect(result?.[0].userId).toBe('U1');
  });

  it('omits authorName when canResolveUsers is false (no users.info call)', async () => {
    let infoCalls = 0;
    const client = {
      users: {
        info: async () => {
          infoCalls++;
          return {};
        },
      },
      conversations: {
        replies: async () => ({ messages: [{ ts: '100', user: 'U1', text: 'hi' }] }),
      },
    } as unknown as WebClient;
    const result = await fetchThreadEntries(client, 'C1', '99', {
      ...OPTS,
      canResolveUsers: false,
    });
    expect(result?.[0].authorName).toBeUndefined();
    expect(infoCalls).toBe(0);
  });

  it('keeps file-only messages with their metadata', async () => {
    const client = makeRepliesClient([
      { ts: '100', user: 'U1', text: '', files: [{ id: 'F1', name: 'logs.txt', size: 14336 }] },
      { ts: '101', user: 'U1', text: 'real message' },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result).toHaveLength(2);
    expect(result?.[0].text).toBe('');
    expect(result?.[0].files).toEqual([{ id: 'F1', name: 'logs.txt', size: 14336 }]);
  });

  it('skips messages with neither text nor files', async () => {
    const client = makeRepliesClient([
      { ts: '100', user: 'U1', text: '' },
      { ts: '101', user: 'U1', text: 'real message' },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result).toHaveLength(1);
    expect(result?.[0].text).toBe('real message');
  });

  it('carries url_private_download through as downloadRef so context files can be fetched', async () => {
    const client = makeRepliesClient([
      {
        ts: '100',
        user: 'U1',
        text: '',
        files: [
          {
            id: 'F1',
            name: 'trace.json',
            size: 81920,
            url_private_download: 'https://slack/download/F1',
          },
        ],
      },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result?.[0].files).toEqual([
      { id: 'F1', name: 'trace.json', size: 81920, downloadRef: 'https://slack/download/F1' },
    ]);
  });

  it('collects files from shared-message attachments too', async () => {
    const client = makeRepliesClient([
      {
        ts: '100',
        user: 'U1',
        text: 'shared',
        attachments: [{ files: [{ id: 'F2', name: 'shared.pdf', mimetype: 'application/pdf' }] }],
      },
    ]);
    const result = await fetchThreadEntries(client, 'C1', '99', OPTS);
    expect(result?.[0].files).toEqual([
      { id: 'F2', name: 'shared.pdf', mimetype: 'application/pdf' },
    ]);
  });

  it('passes oldest through to conversations.replies to bound the fetch', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const client = makeRepliesClient([], capture);
    await fetchThreadEntries(client, 'C1', '99', { ...OPTS, oldest: '150.000100' });
    expect(capture.params?.oldest).toBe('150.000100');
  });
});
