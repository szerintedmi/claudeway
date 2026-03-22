// Voice WebSocket protocol types

// --- Client -> Server ---

export interface TextMessage {
  type: 'text';
  requestId: string;
  text: string;
  tts?: boolean;
}

export interface AudioStartMessage {
  type: 'audio_start';
  requestId: string;
  format: { mimeType: string; sampleRate?: number; channels?: number; encoding?: string };
  tts?: boolean;
}

export interface AudioChunkMessage {
  type: 'audio_chunk';
  requestId: string;
  data: string; // base64-encoded audio bytes
}

export interface AudioEndMessage {
  type: 'audio_end';
  requestId: string;
}

export interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface AuthMessage {
  type: 'auth';
  token: string;
}

export type VoiceClientMessage =
  | TextMessage
  | AudioStartMessage
  | AudioChunkMessage
  | AudioEndMessage
  | CancelMessage
  | PingMessage
  | AuthMessage;

// --- Server -> Client ---

export interface StatusMessage {
  type: 'status';
  requestId: string;
  status: string;
  toolName?: string;
  keyArg?: string;
  phase?: string;
  description?: string;
  usage?: { toolUses: number; tokens: number; durationMs: number };
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

export interface ResponseAudioMessage {
  type: 'response_audio';
  requestId: string;
  data: string; // base64-encoded audio bytes
  encoding: string; // e.g. 'linear16'
  sampleRate: number; // e.g. 24000
}

export interface ResponseAudioEndMessage {
  type: 'response_audio_end';
  requestId: string;
}

export interface ErrorMessage {
  type: 'error';
  requestId: string | null;
  message: string;
}

export interface ChannelInfoMessage {
  type: 'channel_info';
  channelId: string;
  channelName: string;
  repo: string | null;
  model: string;
}

export interface PongMessage {
  type: 'pong';
}

export type VoiceServerMessage =
  | StatusMessage
  | ResponseTextMessage
  | ResponseAudioMessage
  | ResponseAudioEndMessage
  | TranscriptMessage
  | ErrorMessage
  | ChannelInfoMessage
  | PongMessage;

const CLIENT_MESSAGE_TYPES = new Set([
  'text',
  'audio_start',
  'audio_chunk',
  'audio_end',
  'cancel',
  'ping',
  'auth',
]);

/**
 * Parse and validate a raw WebSocket message into a typed client message.
 * Throws on invalid input.
 */
export function parseClientMessage(raw: string): VoiceClientMessage {
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

  if (msg.type === 'auth') {
    if (typeof msg.token !== 'string' || msg.token.length === 0) {
      throw new Error('Missing or empty token field');
    }
    return { type: 'auth', token: msg.token };
  }

  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    throw new Error('Missing or empty requestId');
  }

  if (msg.type === 'text') {
    if (typeof msg.text !== 'string') {
      throw new Error('Missing text field');
    }
    return {
      type: 'text',
      requestId: msg.requestId,
      text: msg.text,
      ...(typeof msg.tts === 'boolean' ? { tts: msg.tts } : {}),
    };
  }

  if (msg.type === 'audio_start') {
    if (typeof msg.format !== 'object' || msg.format === null) {
      throw new Error('Missing format object');
    }
    const fmt = msg.format as Record<string, unknown>;
    if (typeof fmt.mimeType !== 'string' || fmt.mimeType.length === 0) {
      throw new Error('Missing or empty format.mimeType');
    }
    return {
      type: 'audio_start',
      requestId: msg.requestId,
      format: {
        mimeType: fmt.mimeType,
        ...(typeof fmt.sampleRate === 'number' ? { sampleRate: fmt.sampleRate } : {}),
        ...(typeof fmt.channels === 'number' ? { channels: fmt.channels } : {}),
        ...(typeof fmt.encoding === 'string' ? { encoding: fmt.encoding } : {}),
      },
      ...(typeof msg.tts === 'boolean' ? { tts: msg.tts } : {}),
    };
  }

  if (msg.type === 'audio_chunk') {
    if (typeof msg.data !== 'string' || msg.data.length === 0) {
      throw new Error('Missing or empty data field');
    }
    return { type: 'audio_chunk', requestId: msg.requestId, data: msg.data };
  }

  if (msg.type === 'audio_end') {
    return { type: 'audio_end', requestId: msg.requestId };
  }

  // cancel
  return { type: 'cancel', requestId: msg.requestId };
}

/**
 * Serialize a server message to JSON string.
 */
export function serializeServerMessage(msg: VoiceServerMessage): string {
  return JSON.stringify(msg);
}
