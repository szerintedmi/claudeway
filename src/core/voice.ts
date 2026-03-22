/** Audio format descriptor — passed through to the STT/TTS provider as-is */
export interface AudioFormat {
  mimeType: string; // e.g. 'audio/webm;codecs=opus', 'audio/l16;rate=16000'
  sampleRate?: number;
  channels?: number;
  encoding?: string; // e.g. 'linear16', 'opus'
}

export interface TranscriptionResult {
  transcript: string;
  confidence?: number;
}

/** Handle to a live TTS WebSocket stream */
export interface TtsStreamHandle {
  /** Send a sentence/chunk of text for synthesis */
  sendText(text: string): void;
  /** Signal a flush point — audio for all text sent so far should be generated */
  flush(): void;
  /** Flush remaining text, wait for all audio, then close gracefully */
  finalize(): Promise<void>;
  /** Clear pending text/audio buffers (barge-in). Stops audio generation immediately. */
  clear(): void;
  /** Immediately abort — close WebSocket, discard pending audio */
  abort(): void;
  /** Register handler for audio data chunks */
  onAudio(handler: (audio: Buffer) => void): void;
  /** Register handler for errors */
  onError(handler: (error: Error) => void): void;
}

/** TTS configuration passed to createTtsStream */
export interface TtsOptions {
  model: string; // e.g. 'aura-2-thalia-en'
  encoding: string; // e.g. 'linear16'
  sampleRate: number; // e.g. 24000
}

/** Provider-agnostic voice interface (STT + TTS) */
export interface VoiceProvider {
  transcribe(
    audio: Buffer,
    format: AudioFormat,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult>;
  createTtsStream(options: TtsOptions): TtsStreamHandle;
}
