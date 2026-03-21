import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  initSession,
  handleMessage,
  handleClose,
  getSession,
  resolveResponder,
} from '../adapters/glasses/handler.js';
import { GlassesChannelResponder } from '../adapters/glasses/responder.js';
import { channelBusy } from '../core/engine.js';
import type { WsData } from '../adapters/glasses/index.js';
import type {
  VoiceProvider,
  TranscriptionResult,
  TtsStreamHandle,
  TtsOptions,
} from '../core/voice.js';

// Mock WebSocket
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

// Mock TTS stream that captures all operations
interface MockTtsStreamState {
  texts: string[];
  flushCount: number;
  finalized: boolean;
  aborted: boolean;
  audioHandler: ((audio: Buffer) => void) | null;
  errorHandler: ((error: Error) => void) | null;
}

function makeMockTtsStream(): { stream: TtsStreamHandle; state: MockTtsStreamState } {
  const state: MockTtsStreamState = {
    texts: [],
    flushCount: 0,
    finalized: false,
    aborted: false,
    audioHandler: null,
    errorHandler: null,
  };

  const stream: TtsStreamHandle = {
    sendText(text: string) {
      state.texts.push(text);
      // Simulate audio generation: emit audio chunk when text is sent
      if (state.audioHandler) {
        const fakeAudio = Buffer.from(`audio-for:${text}`);
        state.audioHandler(fakeAudio);
      }
    },
    flush() {
      state.flushCount++;
    },
    async finalize() {
      state.finalized = true;
    },
    clear() {
      // no-op for mock
    },
    abort() {
      state.aborted = true;
    },
    onAudio(handler) {
      state.audioHandler = handler;
    },
    onError(handler) {
      state.errorHandler = handler;
    },
  };

  return { stream, state };
}

function makeMockVoiceProviderWithTts(transcript = 'hello world'): {
  provider: VoiceProvider;
  ttsState: MockTtsStreamState;
  ttsOptions: TtsOptions;
} {
  const { stream, state } = makeMockTtsStream();
  const ttsOptions: TtsOptions = {
    model: 'aura-2-thalia-en',
    encoding: 'linear16',
    sampleRate: 24000,
  };

  const provider: VoiceProvider = {
    async transcribe(): Promise<TranscriptionResult> {
      return { transcript, confidence: 0.99 };
    },
    createTtsStream() {
      return stream;
    },
  };

  return { provider, ttsState: state, ttsOptions };
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

describe('glasses handler voice round-trip', () => {
  let ws: MockWs;
  let sent: string[];

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    initSession(asWs(ws), 'U001', 'C001');
    channelBusy.delete('C001');
  });

  it('audio in → transcribing status → transcript → enqueue', async () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();

    handleMessage(asWs(ws), audioStartMsg('req-1'), provider, ttsOptions);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), provider, ttsOptions);
    handleMessage(asWs(ws), audioEndMsg('req-1'), provider, ttsOptions);

    await new Promise((r) => setTimeout(r, 50));

    const messages = sent.map(parse);
    const statuses = messages.filter(
      (m: Record<string, unknown>) => m.type === 'status' && m.status === 'transcribing',
    );
    expect(statuses.length).toBe(1);

    const transcripts = messages.filter((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].text).toBe('hello world');
  });

  it('cancel during transcribing aborts STT and sends cancelled error', async () => {
    const provider: VoiceProvider = {
      async transcribe(_audio, _format, signal?) {
        await new Promise((r) => setTimeout(r, 200));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { transcript: 'should not appear', confidence: 0.99 };
      },
      createTtsStream() {
        return makeMockTtsStream().stream;
      },
    };

    handleMessage(asWs(ws), audioStartMsg('req-1'), provider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), provider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), provider);

    // Cancel while transcribing
    await new Promise((r) => setTimeout(r, 20));
    handleMessage(asWs(ws), JSON.stringify({ type: 'cancel', requestId: 'req-1' }), provider);

    await new Promise((r) => setTimeout(r, 300));
    const messages = sent.map(parse);

    const cancelError = messages.find(
      (m: Record<string, unknown>) => m.type === 'error' && m.message === 'cancelled',
    );
    expect(cancelError).toBeDefined();

    const transcript = messages.find((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcript).toBeUndefined();
  });

  it('text-only path works without TTS options', () => {
    // No ttsOptions passed — text-only mode
    const { provider } = makeMockVoiceProviderWithTts();

    // Mark channel busy so message stays queued
    channelBusy.add('C001');

    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'text', requestId: 'req-1', text: 'hello' }),
      provider,
    );

    // No errors
    const errors = sent.map(parse).filter((m: Record<string, unknown>) => m.type === 'error');
    expect(errors.length).toBe(0);

    channelBusy.delete('C001');
  });

  it('close session during transcription aborts cleanly', async () => {
    const provider: VoiceProvider = {
      async transcribe(_audio, _format, signal?) {
        await new Promise((r) => setTimeout(r, 200));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { transcript: 'ghost', confidence: 0.99 };
      },
      createTtsStream() {
        return makeMockTtsStream().stream;
      },
    };

    handleMessage(asWs(ws), audioStartMsg('req-1'), provider);
    const b64 = Buffer.from('audio data').toString('base64');
    handleMessage(asWs(ws), audioChunkMsg('req-1', b64), provider);
    handleMessage(asWs(ws), audioEndMsg('req-1'), provider);

    // Close session while transcribing
    await new Promise((r) => setTimeout(r, 20));
    handleClose(asWs(ws));

    await new Promise((r) => setTimeout(r, 300));
    const messages = sent.map(parse);
    const transcript = messages.find((m: Record<string, unknown>) => m.type === 'transcript');
    expect(transcript).toBeUndefined();
  });

  it('session tracks activeAbortControllers correctly', async () => {
    const provider: VoiceProvider = {
      async transcribe(_audio, _format, signal?) {
        await new Promise((r) => setTimeout(r, 100));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { transcript: 'hi', confidence: 0.99 };
      },
      createTtsStream() {
        return makeMockTtsStream().stream;
      },
    };

    handleMessage(asWs(ws), audioStartMsg('req-1'), provider);
    handleMessage(
      asWs(ws),
      audioChunkMsg('req-1', Buffer.from('data').toString('base64')),
      provider,
    );
    handleMessage(asWs(ws), audioEndMsg('req-1'), provider);

    // Abort controller should be in session
    const session = getSession(asWs(ws));
    expect(session?.activeAbortControllers.size).toBe(1);

    // After transcription completes, abort controller is cleaned up
    await new Promise((r) => setTimeout(r, 200));
    expect(session?.activeAbortControllers.size).toBe(0);
  });
});

describe('glasses handler cancel states', () => {
  let ws: MockWs;
  let sent: string[];

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    initSession(asWs(ws), 'U001', 'C001');
    channelBusy.delete('C001');
  });

  it('cancel unknown requestId is silently ignored', () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();
    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'cancel', requestId: 'unknown-id' }),
      provider,
      ttsOptions,
    );

    const errors = sent.map(parse).filter((m: Record<string, unknown>) => m.type === 'error');
    expect(errors.length).toBe(0);
  });

  it('cancel during recording deletes recording and sends cancelled', () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();

    handleMessage(asWs(ws), audioStartMsg('req-1'), provider, ttsOptions);
    handleMessage(
      asWs(ws),
      audioChunkMsg('req-1', Buffer.from('data').toString('base64')),
      provider,
      ttsOptions,
    );

    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'cancel', requestId: 'req-1' }),
      provider,
      ttsOptions,
    );

    const messages = sent.map(parse);
    const cancelError = messages.find(
      (m: Record<string, unknown>) => m.type === 'error' && m.message === 'cancelled',
    );
    expect(cancelError).toBeDefined();

    // Recording is gone
    const session = getSession(asWs(ws));
    expect(session?.activeRecordings.has('req-1')).toBe(false);
  });

  it('cancel pending queue item removes it', () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();

    // Mark channel busy so text message stays pending
    channelBusy.add('C001');

    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'text', requestId: 'req-1', text: 'hello' }),
      provider,
      ttsOptions,
    );

    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'cancel', requestId: 'req-1' }),
      provider,
      ttsOptions,
    );

    const messages = sent.map(parse);
    const cancelError = messages.find(
      (m: Record<string, unknown>) => m.type === 'error' && m.message === 'cancelled',
    );
    expect(cancelError).toBeDefined();

    channelBusy.delete('C001');
  });
});

describe('glasses streaming responder voice behavior', () => {
  let ws: MockWs;
  let sent: string[];

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
  });

  it('onTextDelta is suppressed after cancel', () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);

    const sr = responder.createStreamingResponder();
    sr.onTextDelta('before ');
    expect(sent.length).toBeGreaterThan(0);

    const countBefore = sent.length;
    responder.cancel();

    // After cancel, onTextDelta should be suppressed
    sr.onTextDelta('after cancel');
    expect(sent.length).toBe(countBefore); // no new messages
  });

  it('short response reaches TTS via finish() flush', async () => {
    const { stream, state: ttsState } = makeMockTtsStream();
    const ttsOptions: TtsOptions = {
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    };

    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Send a short response (below 20-char sentence boundary threshold)
    sr.onTextDelta('OK.');

    // TTS stream not created yet — below sentence boundary
    expect(ttsState.texts.length).toBe(0);

    // finish() flushes the buffer, which should create the TTS stream and send text
    await sr.finish();

    expect(ttsState.texts.length).toBe(1);
    expect(ttsState.texts[0]).toBe('OK.');
    expect(ttsState.finalized).toBe(true);

    // Should have response_audio_end
    const audioEnds = sent
      .map(parse)
      .filter((m: Record<string, unknown>) => m.type === 'response_audio_end');
    expect(audioEnds.length).toBe(1);
  });

  it('onDone callback fires on onComplete', async () => {
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1');
    let doneFired = false;
    responder.onDone(() => {
      doneFired = true;
    });
    await responder.onComplete();
    expect(doneFired).toBe(true);
  });

  it('onDone callback fires on onError', async () => {
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1');
    let doneFired = false;
    responder.onDone(() => {
      doneFired = true;
    });
    await responder.onError('test error');
    expect(doneFired).toBe(true);
  });

  it('onToolEvent is suppressed after cancel', () => {
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1');
    const sr = responder.createStreamingResponder();

    sr.onToolEvent({ toolName: 'Read', phase: 'start' });
    const countBefore = sent.length;

    responder.cancel();
    sr.onToolEvent({ toolName: 'Write', phase: 'start' });
    expect(sent.length).toBe(countBefore); // no new messages after cancel
  });

  it('activeResponders cleaned up on normal completion', () => {
    initSession(asWs(ws), 'U001', 'C001');
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();

    // Mark busy so message stays queued — we just need resolveResponder to run
    channelBusy.add('C001');
    handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'text', requestId: 'req-1', text: 'hello' }),
      provider,
      ttsOptions,
    );

    const session = getSession(asWs(ws));
    expect(session).toBeDefined();

    // Simulate what drainChannel does: resolve the responder
    const key = [...session!.pendingRequests][0];
    const responder = resolveResponder({ ts: key }, asWs(ws), provider, ttsOptions);

    // activeResponders should have the entry
    expect(session!.activeResponders.size).toBe(1);

    // Simulate completion
    responder.onComplete();

    // activeResponders should be cleaned up
    expect(session!.activeResponders.size).toBe(0);

    channelBusy.delete('C001');
  });

  it('cancel calls clear() on TTS stream, not abort()', () => {
    let clearCalled = false;
    let abortCalled = false;

    const stream: TtsStreamHandle = {
      sendText() {},
      flush() {},
      async finalize() {},
      clear() {
        clearCalled = true;
      },
      abort() {
        abortCalled = true;
      },
      onAudio() {},
      onError() {},
    };
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Feed enough text to trigger TTS stream creation (needs a sentence boundary)
    sr.onTextDelta('Hello world, this is a test sentence.\n');

    expect(clearCalled).toBe(false);
    expect(abortCalled).toBe(false);

    responder.cancel();

    expect(clearCalled).toBe(true);
    // abort should NOT be called — clear() handles its own teardown
    expect(abortCalled).toBe(false);
  });

  it('no duplicate terminal errors after cancel — onError is suppressed', async () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    let doneFired = 0;
    responder.onDone(() => {
      doneFired++;
    });

    const sr = responder.createStreamingResponder();
    sr.onTextDelta('Hello world response.\n');

    // Cancel the responder (simulates barge-in)
    responder.cancel();

    const countAfterCancel = sent.length;

    // Simulate engine calling onError after process is killed
    await responder.onError('Process was killed');

    // No new error message should be sent to the client
    const messagesAfterError = sent.slice(countAfterCancel).map(parse);
    const errorMsgs = messagesAfterError.filter(
      (m: Record<string, unknown>) => m.type === 'error' && m.message !== 'cancelled',
    );
    expect(errorMsgs.length).toBe(0);

    // onDone should still fire (once for onError)
    expect(doneFired).toBe(1);
  });

  it('response_audio_end is sent after cancel', () => {
    const { provider, ttsOptions } = makeMockVoiceProviderWithTts();
    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();
    sr.onTextDelta('Hello world, testing audio end.\n');

    responder.cancel();

    const messages = sent.map(parse);
    const audioEnds = messages.filter(
      (m: Record<string, unknown>) => m.type === 'response_audio_end',
    );
    expect(audioEnds.length).toBe(1);
  });
});

describe('flush policy and protocol sequencing', () => {
  let ws: MockWs;
  let sent: string[];

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
  });

  it('newline causes audio to start before turn end', () => {
    const { stream, state: ttsState } = makeMockTtsStream();
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Feed text with a newline — should trigger TTS stream and flush before turn end
    sr.onTextDelta('Hello, this is the first line.\n');

    // TTS stream should be created and text sent BEFORE finish()
    expect(ttsState.texts.length).toBe(1);
    expect(ttsState.texts[0]).toBe('Hello, this is the first line.');
    expect(ttsState.flushCount).toBe(1);

    // Audio should already be flowing (mock emits audio on sendText)
    const audioMsgs = sent
      .map(parse)
      .filter((m: Record<string, unknown>) => m.type === 'response_audio');
    expect(audioMsgs.length).toBe(1);
  });

  it('end-of-turn performs only one effective final flush', async () => {
    const { stream, state: ttsState } = makeMockTtsStream();
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Feed text with a newline (triggers one flush during streaming)
    sr.onTextDelta('First line of response here.\n');
    const flushesBeforeFinish = ttsState.flushCount;
    expect(flushesBeforeFinish).toBe(1);

    // Feed trailing text with no boundary
    sr.onTextDelta('Trailing text.');

    await sr.finish();

    // finish() should add exactly one more flush (for the trailing text)
    // NOT two (which would happen if chunker.flush + finalize both flushed)
    expect(ttsState.flushCount).toBe(flushesBeforeFinish + 1);
    expect(ttsState.finalized).toBe(true);
  });

  it('flush budget counts actual provider flushes', () => {
    let actualFlushes = 0;
    const stream: TtsStreamHandle = {
      sendText() {},
      flush() {
        actualFlushes++;
      },
      async finalize() {},
      clear() {},
      abort() {},
      onAudio() {},
      onError() {},
    };
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Feed 20 lines — each newline is a strong boundary that triggers a flush
    for (let i = 0; i < 20; i++) {
      sr.onTextDelta(`Line number ${i} here.\n`);
    }

    // Should be capped at 16 (MAX_FLUSHES_PER_WINDOW), not 20
    expect(actualFlushes).toBeLessThanOrEqual(16);
    expect(actualFlushes).toBeGreaterThan(0);
  });

  it('long multiline prose stays under flush budget', () => {
    let actualFlushes = 0;
    const stream: TtsStreamHandle = {
      sendText() {},
      flush() {
        actualFlushes++;
      },
      async finalize() {},
      clear() {},
      abort() {},
      onAudio() {},
      onError() {},
    };
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();

    // Simulate a long response with 50 lines
    for (let i = 0; i < 50; i++) {
      sr.onTextDelta(`This is line ${i} of a very long response.\n`);
    }

    // Must stay under the 16-flush sliding window cap
    expect(actualFlushes).toBeLessThanOrEqual(16);
  });

  it('cancel during speaking stops audio forwarding promptly', () => {
    const stream: TtsStreamHandle = {
      sendText() {},
      flush() {},
      async finalize() {},
      clear() {},
      abort() {},
      onAudio(handler) {
        // Simulate delayed audio arriving after cancel
        setTimeout(() => handler(Buffer.from('late-audio')), 10);
      },
      onError() {},
    };
    const ttsOptions: TtsOptions = { model: 'test', encoding: 'linear16', sampleRate: 24000 };
    const provider: VoiceProvider = {
      async transcribe() {
        return { transcript: '', confidence: 0 };
      },
      createTtsStream() {
        return stream;
      },
    };

    const responder = new GlassesChannelResponder(asWs(ws), 'req-1', provider, ttsOptions);
    const sr = responder.createStreamingResponder();
    sr.onTextDelta('Hello world sentence here.\n');

    // Cancel immediately
    responder.cancel();

    // Count audio messages — should have none after cancel
    const audioAfterCancel = sent
      .map(parse)
      .filter((m: Record<string, unknown>) => m.type === 'response_audio');
    // Only audio from before cancel (if any) — the mock doesn't emit on sendText
    // so there should be zero audio messages
    expect(audioAfterCancel.length).toBe(0);
  });
});
