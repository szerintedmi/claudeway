import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { WebClient } from '@slack/web-api';
import { makeSlackPromptCoordinator } from '../adapters/slack/coordinator.js';
import { resetUserNameCache } from '../adapters/slack/thread.js';
import { deleteSlackHistoryState, loadSlackHistoryState } from '../slack-history.js';
import type { QueuedMessage } from '../queue.js';
import type { SessionState } from '../claude.js';

const SESSION_ID = 'test-slack-coordinator-session';
const CH = 'CCOORD';
const THREAD = '100.000100';

const session = (resuming: boolean): SessionState => ({
  sessionId: SESSION_ID,
  cwd: '/tmp/x',
  resuming,
});

function queuedMsg(ts: string, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    channelId: CH,
    userId: 'U333',
    text: 'please review',
    ts,
    threadTs: THREAD,
    botUserId: 'UBOT',
    queuedAt: new Date().toISOString(),
    slack: {
      rawText: 'please review',
      senderId: 'U333',
      senderName: 'Cara',
      botUserId: 'UBOT',
      botName: 'Claudeway',
    },
    ...over,
  };
}

function mockClient(messages: object[], capture?: { params?: Record<string, unknown> }) {
  return {
    users: {
      info: async ({ user }: { user: string }) => ({
        user: { profile: { display_name_normalized: `${user}-name` } },
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

beforeEach(() => resetUserNameCache());
afterEach(() => deleteSlackHistoryState(SESSION_ID));

describe('makeSlackPromptCoordinator', () => {
  const threadMessages = [
    { ts: THREAD, user: 'U111', text: 'thread start' },
    { ts: '110.000200', user: 'UBOT', bot_id: 'B1', text: 'earlier bot answer' },
    { ts: '120.000300', user: 'U222', text: 'human follow-up' },
  ];

  it('new session: emits header and full prior thread including own bot messages', async () => {
    const coord = makeSlackPromptCoordinator(mockClient(threadMessages));
    const { text } = await coord.prepare(queuedMsg('200.000400'), session(false));
    expect(text).toContain(`=== Slack thread id: ${CH}/${THREAD} ; Bot (you): <@UBOT> Claudeway`);
    expect(text).toContain('--- Slack context ---');
    expect(text).toContain('thread start');
    expect(text).toContain('earlier bot answer');
    expect(text).toContain('(you)]: earlier bot answer');
    expect(text).not.toContain('--- Current Slack message');
    expect(text).toContain('[200.000400 <@U333> Cara]: please review');
  });

  it('resumed session with watermark: no header, unseen human messages only', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const coord = makeSlackPromptCoordinator(mockClient(threadMessages, capture));
    const { text } = await coord.prepare(queuedMsg('200.000400'), session(true));

    // establish a watermark first
    await coord.onTurnCommitted(queuedMsg('115.000250'), session(true));
    const { text: text2 } = await coord.prepare(queuedMsg('200.000400'), session(true));

    expect(text).not.toContain('=== Slack thread id');
    expect(text2).not.toContain('=== Slack thread id');
    // watermark 115.000250 → only 120.000300 is unseen; bot message excluded anyway
    expect(text2).toContain('human follow-up');
    expect(text2).not.toContain('thread start');
    expect(text2).not.toContain('earlier bot answer');
    // fetch was bounded by the watermark
    expect(capture.params?.oldest).toBe('115.000250');
  });

  it('resumed session without watermark: full prior thread minus own bot messages', async () => {
    const coord = makeSlackPromptCoordinator(mockClient(threadMessages));
    const { text } = await coord.prepare(queuedMsg('200.000400'), session(true));
    expect(text).toContain('thread start');
    expect(text).toContain('human follow-up');
    expect(text).not.toContain('earlier bot answer');
  });

  it('thread-starting message skips the fetch entirely', async () => {
    let fetched = false;
    const client = {
      users: { info: async () => ({}) },
      conversations: {
        replies: async () => {
          fetched = true;
          return { messages: [] };
        },
      },
    } as unknown as WebClient;
    const coord = makeSlackPromptCoordinator(client);
    const { text } = await coord.prepare(queuedMsg(THREAD, { threadTs: THREAD }), session(false));
    expect(fetched).toBe(false);
    expect(text).toContain('=== Slack thread id');
    expect(text).not.toContain('--- Slack context ---');
  });

  it('fetch failure degrades to no context instead of failing the turn', async () => {
    const client = {
      users: { info: async () => ({}) },
      conversations: {
        replies: async () => {
          throw new Error('slack down');
        },
      },
      chat: { postMessage: async () => ({}) },
    } as unknown as WebClient;
    const coord = makeSlackPromptCoordinator(client);
    const { text } = await coord.prepare(queuedMsg('200.000400'), session(false));
    expect(text).not.toContain('--- Slack context ---');
    expect(text).toContain('[200.000400 <@U333> Cara]: please review');
  });

  it('onTurnCommitted advances the watermark to the current message ts', async () => {
    const coord = makeSlackPromptCoordinator(mockClient([]));
    await coord.onTurnCommitted(queuedMsg('200.000400'), session(true));
    expect(loadSlackHistoryState(SESSION_ID)?.lastSeenSlackTs).toBe('200.000400');
    expect(loadSlackHistoryState(SESSION_ID)?.channelId).toBe(CH);
  });
});
