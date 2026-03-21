import { describe, it, expect } from 'bun:test';
import type { VoiceProvider } from '../core/voice.js';
import { DeepgramVoiceProvider } from '../core/voice-deepgram.js';

describe('DeepgramVoiceProvider', () => {
  it('implements VoiceProvider interface', () => {
    const provider = new DeepgramVoiceProvider('test-key');
    const vp: VoiceProvider = provider;
    expect(typeof vp.transcribe).toBe('function');
  });

  it('constructor accepts custom sttModel', () => {
    const provider = new DeepgramVoiceProvider('test-key', 'nova-2');
    expect(provider).toBeDefined();
  });
});
