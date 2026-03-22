import { describe, it, expect } from 'bun:test';
import {
  createRecording,
  appendChunk,
  assembleBuffer,
  MAX_AUDIO_BYTES,
} from '../adapters/voice/audio-session.js';

describe('audio-session', () => {
  const format = { mimeType: 'audio/webm;codecs=opus' };

  it('createRecording returns correct initial state', () => {
    const rec = createRecording('req-1', format);
    expect(rec.requestId).toBe('req-1');
    expect(rec.format).toEqual(format);
    expect(rec.chunks).toHaveLength(0);
    expect(rec.totalBytes).toBe(0);
  });

  it('appendChunk accumulates chunks and updates totalBytes', () => {
    const rec = createRecording('req-1', format);
    const chunk1 = Buffer.from('hello');
    const chunk2 = Buffer.from('world');

    expect(appendChunk(rec, chunk1)).toBe(true);
    expect(appendChunk(rec, chunk2)).toBe(true);

    expect(rec.chunks).toHaveLength(2);
    expect(rec.totalBytes).toBe(10);
  });

  it('appendChunk rejects when exceeding MAX_AUDIO_BYTES', () => {
    const rec = createRecording('req-1', format);
    // Fill up to just under the limit
    const bigChunk = Buffer.alloc(MAX_AUDIO_BYTES - 10);
    expect(appendChunk(rec, bigChunk)).toBe(true);

    // This one pushes over
    const overflowChunk = Buffer.alloc(11);
    expect(appendChunk(rec, overflowChunk)).toBe(false);
    expect(rec.chunks).toHaveLength(1); // overflow chunk not appended
    expect(rec.totalBytes).toBe(MAX_AUDIO_BYTES - 10);
  });

  it('appendChunk rejects chunk exactly at the boundary', () => {
    const rec = createRecording('req-1', format);
    const exactChunk = Buffer.alloc(MAX_AUDIO_BYTES);
    expect(appendChunk(rec, exactChunk)).toBe(true);

    // One more byte should fail
    expect(appendChunk(rec, Buffer.alloc(1))).toBe(false);
  });

  it('assembleBuffer concatenates all chunks', () => {
    const rec = createRecording('req-1', format);
    appendChunk(rec, Buffer.from([1, 2, 3]));
    appendChunk(rec, Buffer.from([4, 5]));
    appendChunk(rec, Buffer.from([6]));

    const result = assembleBuffer(rec);
    expect(result).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it('assembleBuffer returns empty buffer for empty recording', () => {
    const rec = createRecording('req-1', format);
    const result = assembleBuffer(rec);
    expect(result.byteLength).toBe(0);
  });
});
