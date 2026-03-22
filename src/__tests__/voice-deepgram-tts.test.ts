import { describe, it, expect } from 'bun:test';
import type { TtsStreamHandle, VoiceProvider } from '../core/voice.js';
import { DeepgramVoiceProvider } from '../core/voice-deepgram.js';

describe('DeepgramVoiceProvider TTS', () => {
  it('implements VoiceProvider interface with createTtsStream', () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const vp: VoiceProvider = provider;
    expect(typeof vp.createTtsStream).toBe('function');
  });

  it('createTtsStream returns a TtsStreamHandle', () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const stream = provider.createTtsStream({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    });
    expect(typeof stream.sendText).toBe('function');
    expect(typeof stream.flush).toBe('function');
    expect(typeof stream.finalize).toBe('function');
    expect(typeof stream.abort).toBe('function');
    expect(typeof stream.onAudio).toBe('function');
    expect(typeof stream.onError).toBe('function');

    // Clean up
    stream.abort();
  });

  it('abort after abort does not throw', () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const stream = provider.createTtsStream({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    });
    stream.abort();
    expect(() => stream.abort()).not.toThrow();
  });

  it('sendText/flush after abort are no-ops', () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const stream = provider.createTtsStream({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    });
    stream.abort();
    expect(() => stream.sendText('hello')).not.toThrow();
    expect(() => stream.flush()).not.toThrow();
  });

  it('finalize after abort resolves immediately', async () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const stream = provider.createTtsStream({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    });
    stream.abort();
    await stream.finalize(); // Should not hang
  });
});

describe('TtsStreamHandle interface compliance', () => {
  it('mock TTS stream satisfies TtsStreamHandle', () => {
    const mock: TtsStreamHandle = {
      sendText() {},
      flush() {},
      async finalize() {},
      clear() {},
      abort() {},
      onAudio() {},
      onError() {},
    };
    expect(typeof mock.sendText).toBe('function');
    expect(typeof mock.finalize).toBe('function');
  });
});
