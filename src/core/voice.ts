/** Audio format descriptor — passed through to the STT provider as-is */
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

/** Provider-agnostic voice interface (STT only for now; TTS added in Phase 3) */
export interface VoiceProvider {
  transcribe(audio: Buffer, format: AudioFormat): Promise<TranscriptionResult>;
}
