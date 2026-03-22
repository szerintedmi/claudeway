import type { AudioFormat } from '../../core/voice.js';

export interface AudioRecording {
  requestId: string;
  format: AudioFormat;
  chunks: Buffer[];
  totalBytes: number;
  /** Client-requested TTS preference from audio_start (undefined = use server default) */
  tts?: boolean;
}

/** Conservative ceiling: 120s of 16kHz 16-bit mono PCM (~3.84 MB). Compressed formats are well under this. */
export const MAX_AUDIO_BYTES = 120 * 16000 * 2;

export function createRecording(
  requestId: string,
  format: AudioFormat,
  tts?: boolean,
): AudioRecording {
  return { requestId, format, chunks: [], totalBytes: 0, tts };
}

/**
 * Append a decoded audio chunk to the recording.
 * Returns false if the recording would exceed MAX_AUDIO_BYTES (chunk is not appended).
 */
export function appendChunk(recording: AudioRecording, chunk: Buffer): boolean {
  if (recording.totalBytes + chunk.byteLength > MAX_AUDIO_BYTES) {
    return false;
  }
  recording.chunks.push(chunk);
  recording.totalBytes += chunk.byteLength;
  return true;
}

/** Concatenate all buffered chunks into a single Buffer for STT. */
export function assembleBuffer(recording: AudioRecording): Buffer {
  return Buffer.concat(recording.chunks);
}
