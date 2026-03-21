import type { ServerWebSocket } from 'bun';
import { randomUUID } from 'crypto';
import { enqueue, dequeue } from '../../queue.js';
import { drainChannel, channelBusy } from '../../core/engine.js';
import { parseClientMessage, serializeServerMessage } from './protocol.js';
import { GlassesChannelResponder } from './responder.js';
import {
  createRecording,
  appendChunk,
  assembleBuffer,
  type AudioRecording,
} from './audio-session.js';
import type { VoiceProvider } from '../../core/voice.js';
import type { WsData } from './index.js';

export interface GlassesSession {
  sessionId: string;
  userId: string;
  defaultChannel: string;
  /** Server-scoped queue keys (sessionId:requestId) that are still pending (not yet processing) */
  pendingRequests: Set<string>;
  /** Maps server-scoped queue key -> client requestId for response routing */
  queueKeyToRequestId: Map<string, string>;
  /** Active audio recordings keyed by client requestId */
  activeRecordings: Map<string, AudioRecording>;
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
    activeRecordings: new Map(),
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

/** Shared helper: enqueue text and start drain if channel is idle */
function enqueueText(
  ws: ServerWebSocket<WsData>,
  session: GlassesSession,
  requestId: string,
  text: string,
): void {
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
    threadTs: session.sessionId, // All requests in a session share Claude context
    queuedAt: new Date().toISOString(),
  });

  if (channelBusy.has(channelId)) {
    return;
  }

  drainChannel(channelId, (queued) => resolveResponder(queued, ws)).catch((err) => {
    console.error(`[glasses:${channelId}] Queue drain error:`, err);
  });
}

function sendMsg(
  ws: ServerWebSocket<WsData>,
  msg: Parameters<typeof serializeServerMessage>[0],
): void {
  try {
    ws.send(serializeServerMessage(msg));
  } catch {
    // Connection may have closed
  }
}

/** Handle audio_end: transcribe and enqueue (async, fire-and-forget) */
async function handleAudioEnd(
  ws: ServerWebSocket<WsData>,
  session: GlassesSession,
  requestId: string,
  recording: AudioRecording,
  voiceProvider: VoiceProvider,
): Promise<void> {
  sendMsg(ws, { type: 'status', requestId, status: 'transcribing' });

  try {
    const buffer = assembleBuffer(recording);
    const result = await voiceProvider.transcribe(buffer, recording.format);

    // Session may have been closed during async transcription
    if (!sessions.has(ws)) return;

    if (!result.transcript) {
      sendMsg(ws, { type: 'error', requestId, message: 'No speech detected' });
      return;
    }

    sendMsg(ws, { type: 'transcript', requestId, text: result.transcript, final: true });
    enqueueText(ws, session, requestId, result.transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed';
    console.error(`[glasses] STT error for ${requestId}:`, message);
    sendMsg(ws, { type: 'error', requestId, message: `Transcription failed: ${message}` });
  }
}

export function handleMessage(
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
  voiceProvider?: VoiceProvider,
): void {
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
      const { requestId } = msg;
      const key = queueKey(session, requestId);
      if (session.pendingRequests.has(key) || session.activeRecordings.has(requestId)) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'Duplicate requestId: already in-flight',
        });
        break;
      }
      enqueueText(ws, session, requestId, msg.text);
      break;
    }

    case 'audio_start': {
      const { requestId, format } = msg;
      const key = queueKey(session, requestId);
      if (session.activeRecordings.has(requestId)) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'Recording already in progress for this requestId',
        });
        break;
      }
      if (session.pendingRequests.has(key)) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'Duplicate requestId: already in-flight',
        });
        break;
      }
      session.activeRecordings.set(requestId, createRecording(requestId, format));
      break;
    }

    case 'audio_chunk': {
      const { requestId, data: b64Data } = msg;
      const recording = session.activeRecordings.get(requestId);
      if (!recording) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'audio_chunk received without audio_start',
        });
        break;
      }
      const chunk = Buffer.from(b64Data, 'base64');
      if (!appendChunk(recording, chunk)) {
        session.activeRecordings.delete(requestId);
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'Audio recording too large (exceeded 120s limit)',
        });
      }
      break;
    }

    case 'audio_end': {
      const { requestId } = msg;
      const recording = session.activeRecordings.get(requestId);
      if (!recording) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'audio_end received without audio_start',
        });
        break;
      }
      // Delete recording before async work — no more chunks possible for this requestId
      session.activeRecordings.delete(requestId);

      if (!voiceProvider) {
        sendMsg(ws, {
          type: 'error',
          requestId,
          message: 'Voice provider not configured',
        });
        break;
      }

      handleAudioEnd(ws, session, requestId, recording, voiceProvider).catch((err) => {
        console.error(`[glasses] Unexpected error in handleAudioEnd:`, err);
      });
      break;
    }

    case 'cancel': {
      const { requestId } = msg;
      const key = queueKey(session, requestId);

      // Cancel active recording if any
      if (session.activeRecordings.has(requestId)) {
        session.activeRecordings.delete(requestId);
        sendMsg(ws, { type: 'error', requestId, message: 'cancelled' });
        break;
      }

      // Cancel pending queue item
      if (session.pendingRequests.has(key)) {
        session.pendingRequests.delete(key);
        session.queueKeyToRequestId.delete(key);
        queueKeyToWs.delete(key);
        dequeue(session.defaultChannel, key);
        sendMsg(ws, { type: 'error', requestId, message: 'cancelled' });
      }
      break;
    }
  }
}

export function handleClose(ws: ServerWebSocket<WsData>): void {
  const session = sessions.get(ws);
  if (!session) return;

  // Clean up active recordings (no STT for orphaned audio)
  session.activeRecordings.clear();

  for (const key of session.pendingRequests) {
    dequeue(session.defaultChannel, key);
    queueKeyToWs.delete(key);
  }
  session.pendingRequests.clear();
  session.queueKeyToRequestId.clear();
  sessions.delete(ws);
}
