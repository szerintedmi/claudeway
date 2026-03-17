import type { ServerWebSocket } from 'bun';
import { randomUUID } from 'crypto';
import { enqueue, dequeue } from '../../queue.js';
import { drainChannel, channelBusy } from '../../core/engine.js';
import { parseClientMessage, serializeServerMessage } from './protocol.js';
import { GlassesChannelResponder } from './responder.js';
import type { WsData } from './index.js';

export interface GlassesSession {
  sessionId: string;
  userId: string;
  defaultChannel: string;
  /** Server-scoped queue keys (sessionId:requestId) that are still pending (not yet processing) */
  pendingRequests: Set<string>;
  /** Maps server-scoped queue key -> client requestId for response routing */
  queueKeyToRequestId: Map<string, string>;
}

const sessions = new WeakMap<ServerWebSocket<WsData>, GlassesSession>();

/**
 * Maps server-scoped queue key -> the WS that owns it.
 * Ensures drainChannel delivers responses to the correct socket.
 * Exported for testing only.
 */
export const queueKeyToWs = new Map<string, ServerWebSocket<WsData>>();

export function getSession(ws: ServerWebSocket<WsData>): GlassesSession | undefined {
  return sessions.get(ws);
}

export function initSession(
  ws: ServerWebSocket<WsData>,
  userId: string,
  defaultChannel: string,
): void {
  sessions.set(ws, {
    sessionId: randomUUID(),
    userId,
    defaultChannel,
    pendingRequests: new Set(),
    queueKeyToRequestId: new Map(),
  });
}

/** Build a server-scoped queue key that is unique across sessions */
function queueKey(session: GlassesSession, requestId: string): string {
  return `${session.sessionId}:${requestId}`;
}

/**
 * Resolve the correct responder for a queued message.
 * Looks up the owning WS via queueKeyToWs and uses its client requestId.
 * Falls back to fallbackWs if the owner is gone (e.g. disconnected during drain).
 */
export function resolveResponder(
  queued: { ts: string },
  fallbackWs: ServerWebSocket<WsData>,
): GlassesChannelResponder {
  const ownerWs = queueKeyToWs.get(queued.ts);
  const ownerSession = ownerWs ? sessions.get(ownerWs) : undefined;
  const clientRequestId = ownerSession?.queueKeyToRequestId.get(queued.ts) ?? queued.ts;

  if (ownerSession) {
    ownerSession.pendingRequests.delete(queued.ts);
    ownerSession.queueKeyToRequestId.delete(queued.ts);
  }
  queueKeyToWs.delete(queued.ts);

  const targetWs = ownerWs ?? fallbackWs;
  return new GlassesChannelResponder(targetWs, clientRequestId);
}

export function handleMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  const session = sessions.get(ws);
  if (!session) return;

  const data = typeof raw === 'string' ? raw : raw.toString('utf-8');

  let msg;
  try {
    msg = parseClientMessage(data);
  } catch (err) {
    ws.send(
      serializeServerMessage({
        type: 'error',
        requestId: null,
        message: err instanceof Error ? err.message : 'Invalid message',
      }),
    );
    return;
  }

  switch (msg.type) {
    case 'ping':
      ws.send(serializeServerMessage({ type: 'pong' }));
      break;

    case 'text': {
      const { requestId, text } = msg;
      const channelId = session.defaultChannel;
      const key = queueKey(session, requestId);

      session.pendingRequests.add(key);
      session.queueKeyToRequestId.set(key, requestId);
      queueKeyToWs.set(key, ws);

      enqueue({
        channelId,
        userId: session.userId,
        text,
        ts: key,
        threadTs: key,
        queuedAt: new Date().toISOString(),
      });

      if (channelBusy.has(channelId)) {
        return;
      }

      drainChannel(channelId, (queued) => resolveResponder(queued, ws)).catch((err) => {
        console.error(`[glasses:${channelId}] Queue drain error:`, err);
      });
      break;
    }

    case 'cancel': {
      const { requestId } = msg;
      const key = queueKey(session, requestId);
      if (session.pendingRequests.has(key)) {
        session.pendingRequests.delete(key);
        session.queueKeyToRequestId.delete(key);
        queueKeyToWs.delete(key);
        dequeue(session.defaultChannel, key);
        ws.send(
          serializeServerMessage({
            type: 'error',
            requestId,
            message: 'cancelled',
          }),
        );
      }
      break;
    }
  }
}

export function handleClose(ws: ServerWebSocket<WsData>): void {
  const session = sessions.get(ws);
  if (!session) return;

  for (const key of session.pendingRequests) {
    dequeue(session.defaultChannel, key);
    queueKeyToWs.delete(key);
  }
  session.pendingRequests.clear();
  session.queueKeyToRequestId.clear();
  sessions.delete(ws);
}
