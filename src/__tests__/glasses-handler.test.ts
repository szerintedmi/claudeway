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
import { channelBusy } from '../core/engine.js';
import type { WsData } from '../adapters/glasses/index.js';
import type { VoiceProvider, TranscriptionResult } from '../core/voice.js';

// Mock ServerWebSocket — only the subset we use
interface MockWs {
  data: WsData;
  send(msg: string): void;
}

function makeMockWs(data?: WsData): { ws: MockWs; sent: string[] } {
  const sent: string[] = [];
  const ws: MockWs = {
    data: data ?? { userId: 'U001', defaultChannel: 'C001', authenticated: true },
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
    const { ws: ws2 } = makeMockWs({ userId: 'U002', defaultChannel: 'C001', authenticated: true });
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
    const { ws: ws1, sent: sent1 } = makeMockWs({
      userId: 'U001',
      defaultChannel: 'C001',
      authenticated: true,
    });
    const { ws: ws2, sent: sent2 } = makeMockWs({
      userId: 'U002',
      defaultChannel: 'C001',
      authenticated: true,
    });
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
    const { ws: ws1 } = makeMockWs({ userId: 'U001', defaultChannel: 'C001', authenticated: true });
    const { ws: ws2, sent: sent2 } = makeMockWs({
      userId: 'U002',
      defaultChannel: 'C001',
      authenticated: true,
    });
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

// --- Audio handler tests ---

function makeMockTtsStream() {
  return {
    sendText() {},
    flush() {},
    async finalize() {},
    clear() {},
    abort() {},
    onAudio() {},
    onError() {},
  };
}

function makeMockVoiceProvider(transcript = 'hello world'): VoiceProvider {
  return {
    async transcribe(): Promise<TranscriptionResult> {
      return { transcript, confidence: 0.99 };
    },
    createTtsStream() {
      return makeMockTtsStream();
    },
  };
}

function makeMockFailingVoiceProvider(errorMessage: string): VoiceProvider {
  return {
    async transcribe(): Promise<TranscriptionResult> {
      throw new Error(errorMessage);
    },
    createTtsStream() {
      return makeMockTtsStream();
    },
  };
}

function audioStartMsg(requestId: string, mimeType = 'audio/webm;codecs=opus'): string {
  return JSON.stringify({ type: 'audio_start', requestId, format: { mimeType } });
}

function audioChunkMsg(requestId: string, data: string): string {
  return JSON.stringify({ type: 'audio_chunk', requestId, data });
}

function audioEndMsg(requestId: string): string {
  return JSON.stringify({ type: 'audio_end', requestId });
}

describe('glasses handler audio', () => {
  let ws: MockWs;
  let sent: string[];
  let voiceProvider: VoiceProvider;

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    initSession(asWs(ws), 'U001', 'C001');
    voiceProvider = makeMockVoiceProvider();
  });

  it('audio_start creates a recording in session', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.has('req-1')).toBe(true);
    expect(sent).toHaveLength(0); // No response on audio_start
  });

  it('audio_chunk without audio_start sends error', () => {
    handleMessage(
      asWs(ws),
      audioChunkMsg('req-1', Buffer.from('audio data').toString('base64')),
      voiceProvider,
    );
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.requestId).toBe('req-1');
    expect(msg.message).toContain('without audio_start');
  });

  it('audio_end without audio_start sends error', () => {
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('without audio_start');
  });

  it('duplicate audio_start for same requestId sends error', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('already in progress');
  });

  it('audio_end without voice provider sends error', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1')); // no voiceProvider
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64));
    handleMessage(asWs(ws), audioEndMsg('req-1'));
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('Voice provider not configured');
  });

  it('full audio flow: start -> chunk -> end triggers STT and transcript', async () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const b64 = Buffer.from('fake audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);

    // Wait for async handleAudioEnd to complete
    await new Promise((r) => setTimeout(r, 50));

    // Should have: status:transcribing, transcript
    const messages = sent.map(parse);
    const statusMsg = messages.find(
      (m: Record<string, unknown>) => m.type === 'status' && m.status === 'transcribing',
    );
    expect(statusMsg).toBeDefined();
    expect(statusMsg!.requestId).toBe('req-1');

    const transcriptMsg = messages.find((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcriptMsg).toBeDefined();
    expect(transcriptMsg!.text).toBe('hello world');
    expect(transcriptMsg!.final).toBe(true);
  });

  it('STT failure sends error to client', async () => {
    const failProvider = makeMockFailingVoiceProvider('API key invalid');

    handleMessage(asWs(ws), audioStartMsg('req-1'), failProvider);
    const b64 = Buffer.from('audio').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), failProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), failProvider);

    await new Promise((r) => setTimeout(r, 50));

    const messages = sent.map(parse);
    const errorMsg = messages.find((m: Record<string, unknown>) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain('Transcription failed');
    expect(errorMsg!.message).toContain('API key invalid');

    // Recording should be cleaned up
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.size).toBe(0);
  });

  it('empty transcript sends error', async () => {
    const emptyProvider = makeMockVoiceProvider('');

    handleMessage(asWs(ws), audioStartMsg('req-1'), emptyProvider);
    const b64 = Buffer.from('silence').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), emptyProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), emptyProvider);

    await new Promise((r) => setTimeout(r, 50));

    const messages = sent.map(parse);
    const errorMsg = messages.find((m: Record<string, unknown>) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain('No speech detected');
  });

  it('text messages work independently during recording', () => {
    // Start a recording
    handleMessage(asWs(ws), audioStartMsg('req-audio'), voiceProvider);

    // Mark channel busy so drainChannel doesn't consume the pending request
    channelBusy.add('C001');
    try {
      // Send a text message with a different requestId
      handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'text', requestId: 'req-text', text: 'hello' }),
        voiceProvider,
      );

      // Recording is still active
      const session = getSession(asWs(ws))!;
      expect(session.activeRecordings.has('req-audio')).toBe(true);
      // Text message was queued (pendingRequests has the queue key)
      expect(session.pendingRequests.size).toBe(1);
    } finally {
      channelBusy.delete('C001');
    }
  });

  it('cancel during recording removes recording and sends cancelled', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const b64 = Buffer.from('audio').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);

    // Cancel before audio_end
    handleMessage(asWs(ws), JSON.stringify({ type: 'cancel', requestId: 'req-1' }), voiceProvider);

    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toBe('cancelled');

    // Recording cleaned up
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.has('req-1')).toBe(false);
  });

  it('handleClose clears active recordings', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.size).toBe(1);

    handleClose(asWs(ws));
    expect(getSession(asWs(ws))).toBeUndefined();
  });

  it('audio_chunk over size limit sends error and cleans up recording', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);

    // Send a chunk that exceeds MAX_AUDIO_BYTES
    const hugeChunk = Buffer.alloc(120 * 16000 * 2 + 1); // Just over the limit
    const b64 = hugeChunk.toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);

    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('too large');

    // Recording removed
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.has('req-1')).toBe(false);
  });

  // --- Edge-case tests (covers real client bugs) ---

  it('audio_chunk after audio_end gets error (async FileReader race)', async () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);

    // Late chunk arrives after recording was consumed by audio_end
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);

    const messages = sent.map(parse);
    const lateChunkError = messages.find(
      (m: Record<string, unknown>) =>
        m.type === 'error' && (m.message as string).includes('without audio_start'),
    );
    expect(lateChunkError).toBeDefined();
    expect(lateChunkError!.requestId).toBe('req-1');
  });

  it('audio_end sent twice gets error on second', async () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);

    // Second audio_end — recording already consumed
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);

    const messages = sent.map(parse);
    const secondEndError = messages.find(
      (m: Record<string, unknown>) =>
        m.type === 'error' && (m.message as string).includes('without audio_start'),
    );
    expect(secondEndError).toBeDefined();
    expect(secondEndError!.requestId).toBe('req-1');
  });

  it('session close during async transcription does not send ghost response', async () => {
    // Use a slow voice provider to simulate async gap
    const slowProvider: VoiceProvider = {
      async transcribe() {
        await new Promise((r) => setTimeout(r, 100));
        return { transcript: 'ghost', confidence: 0.99 };
      },
      createTtsStream() {
        return makeMockTtsStream();
      },
    };

    handleMessage(asWs(ws), audioStartMsg('req-1'), slowProvider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), slowProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), slowProvider);

    // Close session immediately — before transcription resolves
    handleClose(asWs(ws));

    // Wait for transcription to complete
    await new Promise((r) => setTimeout(r, 200));

    // Should have status:transcribing but NOT a transcript message (session gone)
    const messages = sent.map(parse);
    const transcriptMsg = messages.find((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcriptMsg).toBeUndefined();
  });

  it('overlapping recordings with different requestIds work independently', async () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    handleMessage(asWs(ws), audioStartMsg('req-2'), voiceProvider);

    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);
    handleMessage(asWs(ws), audioChunkMsg('req-2', b64), voiceProvider);

    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.has('req-1')).toBe(true);
    expect(session.activeRecordings.has('req-2')).toBe(true);

    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-2'), voiceProvider);

    await new Promise((r) => setTimeout(r, 50));

    const messages = sent.map(parse);
    const transcripts = messages.filter((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcripts).toHaveLength(2);
    expect(transcripts.map((t: Record<string, unknown>) => t.requestId).sort()).toEqual([
      'req-1',
      'req-2',
    ]);
  });

  it('sequential recordings both complete independently', async () => {
    // First recording
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), voiceProvider);

    await new Promise((r) => setTimeout(r, 50));

    // Second recording
    handleMessage(asWs(ws), audioStartMsg('req-2'), voiceProvider);
    handleMessage(asWs(ws), audioChunkMsg('req-2', b64), voiceProvider);
    handleMessage(asWs(ws), audioEndMsg('req-2'), voiceProvider);

    await new Promise((r) => setTimeout(r, 50));

    const messages = sent.map(parse);
    const transcripts = messages.filter((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].requestId).toBe('req-1');
    expect(transcripts[1].requestId).toBe('req-2');
  });

  it('cancel after audio_end aborts in-flight transcription', async () => {
    const slowProvider: VoiceProvider = {
      async transcribe(_audio, _format, signal?) {
        await new Promise((r) => setTimeout(r, 100));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { transcript: 'hello', confidence: 0.99 };
      },
      createTtsStream() {
        return makeMockTtsStream();
      },
    };

    handleMessage(asWs(ws), audioStartMsg('req-1'), slowProvider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), slowProvider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), slowProvider);

    // Cancel while transcription is in-flight
    handleMessage(asWs(ws), JSON.stringify({ type: 'cancel', requestId: 'req-1' }), slowProvider);

    // Cancel error sent immediately via abort controller
    const immediateMessages = sent.map(parse);
    const cancelError = immediateMessages.find(
      (m: Record<string, unknown>) => m.type === 'error' && m.message === 'cancelled',
    );
    expect(cancelError).toBeDefined();

    // Transcription does NOT complete (aborted)
    await new Promise((r) => setTimeout(r, 200));
    const allMessages = sent.map(parse);
    const transcript = allMessages.find((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcript).toBeUndefined();
  });

  it('rejects audio_start when same requestId is already pending as text', () => {
    // Mark channel busy so text doesn't get consumed immediately
    channelBusy.add('C001');
    try {
      // Send text with req-1
      handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'text', requestId: 'req-1', text: 'typed text' }),
        voiceProvider,
      );

      // Attempt audio_start with same requestId — should be rejected
      handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);

      const session = getSession(asWs(ws))!;
      expect(session.activeRecordings.has('req-1')).toBe(false);

      const messages = sent.map(parse);
      const errorMsg = messages.find(
        (m: Record<string, unknown>) =>
          m.type === 'error' && (m.message as string).includes('Duplicate requestId'),
      );
      expect(errorMsg).toBeDefined();
    } finally {
      channelBusy.delete('C001');
    }
  });

  it('rejects text when same requestId is already recording', () => {
    handleMessage(asWs(ws), audioStartMsg('req-1'), voiceProvider);

    // Attempt text with same requestId — should be rejected
    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'text', requestId: 'req-1', text: 'typed text' }),
      voiceProvider,
    );

    const messages = sent.map(parse);
    const errorMsg = messages.find(
      (m: Record<string, unknown>) =>
        m.type === 'error' && (m.message as string).includes('Duplicate requestId'),
    );
    expect(errorMsg).toBeDefined();

    // Recording is still active
    const session = getSession(asWs(ws))!;
    expect(session.activeRecordings.has('req-1')).toBe(true);
  });

  it('rejects duplicate text requestId when first is still pending', () => {
    channelBusy.add('C001');
    try {
      handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'text', requestId: 'req-1', text: 'first' }),
        voiceProvider,
      );
      handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'text', requestId: 'req-1', text: 'second' }),
        voiceProvider,
      );

      const messages = sent.map(parse);
      const errorMsg = messages.find(
        (m: Record<string, unknown>) =>
          m.type === 'error' && (m.message as string).includes('Duplicate requestId'),
      );
      expect(errorMsg).toBeDefined();

      const session = getSession(asWs(ws))!;
      // Only one pending request
      expect(session.pendingRequests.size).toBe(1);
    } finally {
      channelBusy.delete('C001');
    }
  });

  it('session uses shared threadTs for Claude context', () => {
    // This test verifies that all requests in a session share the same threadTs (sessionId)
    // by checking that the enqueued message uses session.sessionId as the queue key prefix
    const session = getSession(asWs(ws))!;

    // Mark channel busy so drainChannel doesn't consume the pending request
    channelBusy.add('C001');
    try {
      handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'text', requestId: 'req-1', text: 'hello' }),
        voiceProvider,
      );

      // The queue key should be sessionId:requestId
      const expectedKey = `${session.sessionId}:req-1`;
      expect(session.pendingRequests.has(expectedKey)).toBe(true);
    } finally {
      channelBusy.delete('C001');
    }
  });
});
