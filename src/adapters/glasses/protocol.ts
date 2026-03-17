// Glasses WebSocket protocol types — Phase 1 (text only)

// --- Client -> Server ---

export interface TextMessage {
  type: 'text';
  requestId: string;
  text: string;
}

export interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type GlassesClientMessage = TextMessage | CancelMessage | PingMessage;

// --- Server -> Client ---

export interface StatusMessage {
  type: 'status';
  requestId: string;
  status: string;
}

export interface ResponseTextMessage {
  type: 'response_text';
  requestId: string;
  text: string;
  final: boolean;
}

export interface TranscriptMessage {
  type: 'transcript';
  requestId: string;
  text: string;
  final: boolean;
}

export interface ErrorMessage {
  type: 'error';
  requestId: string | null;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export type GlassesServerMessage =
  | StatusMessage
  | ResponseTextMessage
  | TranscriptMessage
  | ErrorMessage
  | PongMessage;

const CLIENT_MESSAGE_TYPES = new Set(['text', 'cancel', 'ping']);

/**
 * Parse and validate a raw WebSocket message into a typed client message.
 * Throws on invalid input.
 */
export function parseClientMessage(raw: string): GlassesClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Message must be a JSON object');
  }

  const msg = parsed as Record<string, unknown>;

  if (typeof msg.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(msg.type)) {
    throw new Error(`Unknown or missing message type: ${String(msg.type)}`);
  }

  if (msg.type === 'ping') {
    return { type: 'ping' };
  }

  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    throw new Error('Missing or empty requestId');
  }

  if (msg.type === 'text') {
    if (typeof msg.text !== 'string') {
      throw new Error('Missing text field');
    }
    return { type: 'text', requestId: msg.requestId, text: msg.text };
  }

  // cancel
  return { type: 'cancel', requestId: msg.requestId };
}

/**
 * Serialize a server message to JSON string.
 */
export function serializeServerMessage(msg: GlassesServerMessage): string {
  return JSON.stringify(msg);
}
