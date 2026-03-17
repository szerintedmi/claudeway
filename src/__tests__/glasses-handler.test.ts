import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  initSession,
  handleMessage,
  handleClose,
  getSession,
  resolveResponder,
  queueKeyToWs,
} from '../adapters/glasses/handler.js';
import type { WsData } from '../adapters/glasses/index.js';

// Mock ServerWebSocket — only the subset we use
interface MockWs {
  data: WsData;
  send(msg: string): void;
}

function makeMockWs(data?: WsData): { ws: MockWs; sent: string[] } {
  const sent: string[] = [];
  const ws: MockWs = {
    data: data ?? { userId: 'U001', defaultChannel: 'C001' },
    send(msg: string) {
      sent.push(msg);
    },
  };
  return { ws, sent };
}

function parse(s: string) {
  return JSON.parse(s);
}

function asWs(mock: MockWs): ServerWebSocket<WsData> {
  return mock as unknown as ServerWebSocket<WsData>;
}

describe('glasses handler', () => {
  let ws: MockWs;
  let sent: string[];

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    initSession(asWs(ws), 'U001', 'C001');
  });

  it('sends pong on ping', () => {
    handleMessage(asWs(ws), '{"type":"ping"}');
    expect(sent).toHaveLength(1);
    expect(parse(sent[0])).toEqual({ type: 'pong' });
  });

  it('sends error on invalid message format', () => {
    handleMessage(asWs(ws), 'not json');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.requestId).toBeNull();
    expect(msg.message).toContain('Invalid JSON');
  });

  it('sends error on unknown message type', () => {
    handleMessage(asWs(ws), '{"type":"foo"}');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('Unknown or missing message type');
  });

  it('cancel removes queued message and sends cancelled error', () => {
    const session = getSession(asWs(ws))!;
    // Simulate a pending request with the server-scoped key
    const key = `${session.sessionId}:req-1`;
    session.pendingRequests.add(key);
    session.queueKeyToRequestId.set(key, 'req-1');

    handleMessage(asWs(ws), '{"type":"cancel","requestId":"req-1"}');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.requestId).toBe('req-1');
    expect(msg.message).toBe('cancelled');

    expect(session.pendingRequests.has(key)).toBe(false);
    expect(session.queueKeyToRequestId.has(key)).toBe(false);
  });

  it('cancel for unknown requestId is silently ignored', () => {
    handleMessage(asWs(ws), '{"type":"cancel","requestId":"unknown"}');
    expect(sent).toHaveLength(0);
  });

  it('handleClose clears session', () => {
    expect(getSession(asWs(ws))).toBeDefined();
    handleClose(asWs(ws));
    expect(getSession(asWs(ws))).toBeUndefined();
  });

  it('handles message without session gracefully', () => {
    const { ws: ws2, sent: sent2 } = makeMockWs();
    handleMessage(asWs(ws2), '{"type":"ping"}');
    expect(sent2).toHaveLength(0);
  });

  it('different sessions get different queue keys for same requestId', () => {
    const { ws: ws2 } = makeMockWs({ userId: 'U002', defaultChannel: 'C001' });
    initSession(asWs(ws2), 'U002', 'C001');

    const session1 = getSession(asWs(ws))!;
    const session2 = getSession(asWs(ws2))!;

    expect(session1.sessionId).not.toBe(session2.sessionId);
  });
});

describe('resolveResponder cross-session routing', () => {
  afterEach(() => {
    queueKeyToWs.clear();
  });

  it('delivers each queued message to its owning socket, not the drain initiator', () => {
    // Set up two clients on the same channel
    const { ws: ws1, sent: sent1 } = makeMockWs({ userId: 'U001', defaultChannel: 'C001' });
    const { ws: ws2, sent: sent2 } = makeMockWs({ userId: 'U002', defaultChannel: 'C001' });
    initSession(asWs(ws1), 'U001', 'C001');
    initSession(asWs(ws2), 'U002', 'C001');

    const session1 = getSession(asWs(ws1))!;
    const session2 = getSession(asWs(ws2))!;

    // Simulate both clients having queued a message with the same client requestId
    const key1 = `${session1.sessionId}:req-1`;
    const key2 = `${session2.sessionId}:req-1`;

    session1.pendingRequests.add(key1);
    session1.queueKeyToRequestId.set(key1, 'req-1');
    queueKeyToWs.set(key1, asWs(ws1));

    session2.pendingRequests.add(key2);
    session2.queueKeyToRequestId.set(key2, 'req-1');
    queueKeyToWs.set(key2, asWs(ws2));

    // Resolve responders as drainChannel would — ws2 initiates the drain,
    // but ws1's message should still route to ws1
    const responder1 = resolveResponder({ ts: key1 }, asWs(ws2));
    const responder2 = resolveResponder({ ts: key2 }, asWs(ws1));

    // Send a response through each responder
    responder1.sendResponse('response for client 1');
    responder2.sendResponse('response for client 2');

    // Client 1's socket got client 1's response
    expect(sent1).toHaveLength(1);
    const msg1 = parse(sent1[0]);
    expect(msg1.text).toBe('response for client 1');
    expect(msg1.requestId).toBe('req-1');

    // Client 2's socket got client 2's response
    expect(sent2).toHaveLength(1);
    const msg2 = parse(sent2[0]);
    expect(msg2.text).toBe('response for client 2');
    expect(msg2.requestId).toBe('req-1');

    // Tracking state cleaned up
    expect(queueKeyToWs.size).toBe(0);
    expect(session1.pendingRequests.size).toBe(0);
    expect(session2.pendingRequests.size).toBe(0);
  });

  it('falls back to drain initiator when owner disconnected', () => {
    const { ws: ws1 } = makeMockWs({ userId: 'U001', defaultChannel: 'C001' });
    const { ws: ws2, sent: sent2 } = makeMockWs({ userId: 'U002', defaultChannel: 'C001' });
    initSession(asWs(ws1), 'U001', 'C001');
    initSession(asWs(ws2), 'U002', 'C001');

    const session1 = getSession(asWs(ws1))!;
    const key1 = `${session1.sessionId}:req-1`;

    session1.pendingRequests.add(key1);
    session1.queueKeyToRequestId.set(key1, 'req-1');
    queueKeyToWs.set(key1, asWs(ws1));

    // Simulate ws1 disconnecting — handleClose removes session but
    // suppose the queue key wasn't cleaned (race). Clear the owner mapping
    // to simulate owner gone.
    queueKeyToWs.delete(key1);

    // Resolve with ws2 as fallback (drain initiator)
    const responder = resolveResponder({ ts: key1 }, asWs(ws2));
    responder.sendResponse('orphaned response');

    // Falls back to ws2
    expect(sent2).toHaveLength(1);
    expect(parse(sent2[0]).text).toBe('orphaned response');
  });
});
