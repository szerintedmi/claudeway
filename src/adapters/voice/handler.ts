import type { ServerWebSocket } from 'bun';
import { randomUUID } from 'crypto';
import { enqueue, dequeue } from '../../queue.js';
import { drainChannel, channelBusy } from '../../core/engine.js';
import { parseClientMessage, serializeServerMessage } from './protocol.js';
import { VoiceChannelResponder } from './responder.js';
import {
  createRecording,
  appendChunk,
  assembleBuffer,
  type AudioRecording,
} from './audio-session.js';
import type { VoiceProvider, TtsOptions } from '../../core/voice.js';
import type { WsData } from './index.js';

export interface VoiceSession {
  sessionId: string;
  userId: string;
  defaultChannel: string;
  /** Server-scoped queue keys (sessionId:requestId) that are still pending (not yet processing) */
  pendingRequests: Set<string>;
  /** Maps server-scoped queue key -> client requestId for response routing */
  queueKeyToRequestId: Map<string, string>;
  /** Active audio recordings keyed by client requestId */
  activeRecordings: Map<string, AudioRecording>;
  /** AbortControllers for in-flight STT transcriptions, keyed by client requestId */
  activeAbortControllers: Map<string, AbortController>;
  /** Active responders for in-flight requests (processing/speaking), keyed by client requestId */
  activeResponders: Map<string, VoiceChannelResponder>;
}

const sessions = new WeakMap<ServerWebSocket<WsData>, VoiceSession>();

/**
 * Maps server-scoped queue key -> the WS that owns it.
 * Ensures drainChannel delivers responses to the correct socket.
 * Exported for testing only.
 */
export const queueKeyToWs = new Map<string, ServerWebSocket<WsData>>();

export function getSession(ws: ServerWebSocket<WsData>): VoiceSession | undefined {
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
    activeAbortControllers: new Map(),
    activeResponders: new Map(),
  });
}

/** Build a server-scoped queue key that is unique across sessions */
function queueKey(session: VoiceSession, requestId: string): string {
  return `${session.sessionId}:${requestId}`;
}

/** Cancel all active and pending work for a session (barge-in support) */
function cancelActiveResponders(ws: ServerWebSocket<WsData>, session: VoiceSession): void {
  // Cancel active responders (thinking or speaking)
  for (const [reqId, responder] of session.activeResponders) {
    responder.cancel();
    session.activeResponders.delete(reqId);
    sendMsg(ws, { type: 'error', requestId: reqId, message: 'cancelled' });
  }
  // Abort in-flight STT transcriptions
  for (const [reqId, controller] of session.activeAbortControllers) {
    controller.abort();
    session.activeAbortControllers.delete(reqId);
    sendMsg(ws, { type: 'error', requestId: reqId, message: 'cancelled' });
  }
  // Cancel pending queued requests (not yet picked up by engine)
  for (const key of session.pendingRequests) {
    const clientReqId = session.queueKeyToRequestId.get(key) ?? key;
    session.queueKeyToRequestId.delete(key);
    queueKeyToWs.delete(key);
    dequeue(session.defaultChannel, key);
    sendMsg(ws, { type: 'error', requestId: clientReqId, message: 'cancelled' });
  }
  session.pendingRequests.clear();
}

/**
 * Resolve the correct responder for a queued message.
 * Looks up the owning WS via queueKeyToWs and uses its client requestId.
 * Falls back to fallbackWs if the owner is gone (e.g. disconnected during drain).
 */
export function resolveResponder(
  queued: { ts: string },
  fallbackWs: ServerWebSocket<WsData>,
  voiceProvider?: VoiceProvider,
  ttsOptions?: TtsOptions,
): VoiceChannelResponder {
  const ownerWs = queueKeyToWs.get(queued.ts);
  const ownerSession = ownerWs ? sessions.get(ownerWs) : undefined;
  const clientRequestId = ownerSession?.queueKeyToRequestId.get(queued.ts) ?? queued.ts;

  if (ownerSession) {
    ownerSession.pendingRequests.delete(queued.ts);
    ownerSession.queueKeyToRequestId.delete(queued.ts);
  }
  queueKeyToWs.delete(queued.ts);

  const targetWs = ownerWs ?? fallbackWs;
  const responder = new VoiceChannelResponder(targetWs, clientRequestId, voiceProvider, ttsOptions);

  // Track the active responder for cancellation, clean up when done
  if (ownerSession) {
    ownerSession.activeResponders.set(clientRequestId, responder);
    responder.onDone(() => {
      ownerSession.activeResponders.delete(clientRequestId);
    });
  }

  return responder;
}

/** Shared helper: enqueue text and start drain if channel is idle */
function enqueueText(
  ws: ServerWebSocket<WsData>,
  session: VoiceSession,
  requestId: string,
  text: string,
  voiceProvider?: VoiceProvider,
  ttsOptions?: TtsOptions,
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
    adapter: 'voice',
  });

  if (channelBusy.has(channelId)) {
    return;
  }

  drainChannel(channelId, (queued) => {
    const responder = resolveResponder(queued, ws, voiceProvider, ttsOptions);
    return responder;
  }).catch((err) => {
    console.error(`[voice:${channelId}] Queue drain error:`, err);
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
  session: VoiceSession,
  requestId: string,
  recording: AudioRecording,
  voiceProvider: VoiceProvider,
  ttsOptions?: TtsOptions,
): Promise<void> {
  sendMsg(ws, { type: 'status', requestId, status: 'transcribing' });

  const abortController = new AbortController();
  session.activeAbortControllers.set(requestId, abortController);

  try {
    const buffer = assembleBuffer(recording);
    const result = await voiceProvider.transcribe(buffer, recording.format, abortController.signal);

    // Session may have been closed during async transcription
    if (!sessions.has(ws)) return;

    // Clean up abort controller
    session.activeAbortControllers.delete(requestId);

    if (abortController.signal.aborted) return;

    if (!result.transcript) {
      sendMsg(ws, { type: 'error', requestId, message: 'No speech detected' });
      return;
    }

    sendMsg(ws, { type: 'transcript', requestId, text: result.transcript, final: true });
    enqueueText(ws, session, requestId, result.transcript, voiceProvider, ttsOptions);
  } catch (err) {
    session.activeAbortControllers.delete(requestId);

    if (abortController.signal.aborted) {
      // Cancelled — error already sent by cancel handler
      return;
    }

    const message = err instanceof Error ? err.message : 'Transcription failed';
    console.error(`[voice] STT error for ${requestId}:`, message);
    sendMsg(ws, { type: 'error', requestId, message: `Transcription failed: ${message}` });
  }
}

export function handleMessage(
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
  voiceProvider?: VoiceProvider,
  ttsOptions?: TtsOptions,
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
      // Auto-cancel any active responder (barge-in)
      cancelActiveResponders(ws, session);
      enqueueText(ws, session, requestId, msg.text, voiceProvider, ttsOptions);
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
      // Auto-cancel any active responder (barge-in)
      cancelActiveResponders(ws, session);
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

      handleAudioEnd(ws, session, requestId, recording, voiceProvider, ttsOptions).catch((err) => {
        console.error(`[voice] Unexpected error in handleAudioEnd:`, err);
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

      // Cancel in-flight STT transcription
      const abortController = session.activeAbortControllers.get(requestId);
      if (abortController) {
        abortController.abort();
        session.activeAbortControllers.delete(requestId);
        sendMsg(ws, { type: 'error', requestId, message: 'cancelled' });
        break;
      }

      // Cancel active responder (thinking or speaking)
      const responder = session.activeResponders.get(requestId);
      if (responder) {
        responder.cancel();
        session.activeResponders.delete(requestId);
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

  // Abort any in-flight transcriptions
  for (const controller of session.activeAbortControllers.values()) {
    controller.abort();
  }
  session.activeAbortControllers.clear();

  // Cancel active responders
  for (const responder of session.activeResponders.values()) {
    responder.cancel();
  }
  session.activeResponders.clear();

  for (const key of session.pendingRequests) {
    dequeue(session.defaultChannel, key);
    queueKeyToWs.delete(key);
  }
  session.pendingRequests.clear();
  session.queueKeyToRequestId.clear();
  sessions.delete(ws);
}
