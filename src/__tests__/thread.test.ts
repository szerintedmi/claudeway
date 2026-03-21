import { beforeEach, describe, it, expect, spyOn } from 'bun:test';
import type { WebClient } from '@slack/web-api';
import {
  resetUserNameCache,
  resolveUserName,
  fetchThreadContext,
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

function makeFailingUserClient() {
  return {
    users: {
      info: async () => {
        throw new Error('API error');
      },
    },
  } as unknown as WebClient;
}

function makeRepliesClient(messages: object[]) {
  return {
    users: {
      info: async ({ user }: { user: string }) => ({
        user: { profile: { display_name_normalized: user + '-display' } },
      }),
    },
    conversations: {
      replies: async () => ({ messages }),
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
    const name = await resolveUserName(makeFailingUserClient(), 'U003');
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

describe('fetchThreadContext', () => {
  it('returns empty array when conversations.replies throws', async () => {
    const client = {
      users: { info: async () => ({}) },
      conversations: {
        replies: async () => {
          throw new Error('fail');
        },
      },
    } as unknown as WebClient;
    const result = await fetchThreadContext(client, 'C1', '100', '200', 'UBOT');
    expect(result).toEqual([]);
  });

  it('excludes the triggering message by ts', async () => {
    const client = makeRepliesClient([
      { ts: '100', user: 'U1', text: 'first' },
      { ts: '200', user: 'U2', text: 'trigger' },
    ]);
    const result = await fetchThreadContext(client, 'C1', '100', '200', 'UBOT');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('first');
  });

  it('resolves bot display name when canResolveUsers is true', async () => {
    const client = makeRepliesClient([
      { ts: '100', bot_id: 'B1', user: 'UBOT', text: 'bot reply' },
    ]);
    const result = await fetchThreadContext(client, 'C1', '99', '200', 'UBOT', true);
    expect(result[0].isBot).toBe(true);
    expect(result[0].authorName).toBe('UBOT-display');
  });

  it('falls back to Claude when canResolveUsers is false', async () => {
    const client = makeRepliesClient([
      { ts: '100', bot_id: 'B1', user: 'UBOT', text: 'bot reply' },
    ]);
    const result = await fetchThreadContext(client, 'C1', '99', '200', 'UBOT', false);
    expect(result[0].isBot).toBe(true);
    expect(result[0].authorName).toBe('Claude');
  });

  it('resolves human display names', async () => {
    const client = makeRepliesClient([{ ts: '100', user: 'U1', text: 'hello' }]);
    const result = await fetchThreadContext(client, 'C1', '99', '200', 'UBOT');
    expect(result[0].authorName).toBe('U1-display');
  });

  it('skips messages with empty text', async () => {
    const client = makeRepliesClient([
      { ts: '100', user: 'U1', text: '' },
      { ts: '101', user: 'U1', text: 'real message' },
    ]);
    const result = await fetchThreadContext(client, 'C1', '99', '200', 'UBOT');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('real message');
  });
});
