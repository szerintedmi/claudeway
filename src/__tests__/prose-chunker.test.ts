import { describe, it, expect } from 'bun:test';
import { ProseChunker, type Chunk } from '../core/prose-chunker.js';

function collect(input: string | string[]): Chunk[] {
  const chunks: Chunk[] = [];
  const chunker = new ProseChunker((c) => chunks.push(c));
  if (Array.isArray(input)) {
    for (const text of input) chunker.push(text);
  } else {
    chunker.push(input);
  }
  chunker.flush();
  return chunks;
}

/** Collect only chunks emitted BEFORE flush() (i.e., during push()) */
function collectBeforeFlush(input: string | string[]): Chunk[] {
  const chunks: Chunk[] = [];
  const chunker = new ProseChunker((c) => chunks.push(c));
  if (Array.isArray(input)) {
    for (const text of input) chunker.push(text);
  } else {
    chunker.push(input);
  }
  return chunks;
}

describe('ProseChunker', () => {
  describe('newline boundaries', () => {
    it('single newline triggers chunk with newline boundary', () => {
      const chunks = collectBeforeFlush('Hello world\nNext line here');
      expect(chunks).toEqual([{ text: 'Hello world', boundary: 'newline' }]);
    });

    it('paragraph break (double newline) triggers newline boundary', () => {
      const chunks = collectBeforeFlush('First paragraph\n\nSecond paragraph');
      expect(chunks).toEqual([{ text: 'First paragraph', boundary: 'newline' }]);
    });

    it('multiple short lines each emit before turn end', () => {
      const chunks = collectBeforeFlush('Line one\nLine two\nLine three\n');
      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.boundary === 'newline')).toBe(true);
      expect(chunks.map((c) => c.text)).toEqual(['Line one', 'Line two', 'Line three']);
    });

    it('newline does not get stuck until finalization', () => {
      const chunks = collectBeforeFlush('Hello\nWorld');
      // 'Hello' should emit immediately on newline, 'World' stays buffered
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toEqual({ text: 'Hello', boundary: 'newline' });
    });
  });

  describe('sentence boundaries', () => {
    it('splits on sentence-ending punctuation', () => {
      const chunks = collect('This is the first sentence here. This is the second sentence now.');
      expect(chunks.map((c) => c.text)).toEqual([
        'This is the first sentence here.',
        'This is the second sentence now.',
      ]);
      expect(chunks[0].boundary).toBe('sentence');
    });

    it('preserves abbreviations', () => {
      const chunks = collect(
        'Dr. Smith went to the store e.g. the grocery. Then he left the building.',
      );
      expect(chunks.map((c) => c.text)).toEqual([
        'Dr. Smith went to the store e.g. the grocery.',
        'Then he left the building.',
      ]);
    });

    it('preserves ellipsis', () => {
      const chunks = collect('I was thinking... maybe we should try a different approach here.');
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('thinking...');
    });

    it('preserves decimals', () => {
      const chunks = collect('The value is 3.14 which is approximately pi. That is correct here.');
      expect(chunks[0].text).toContain('3.14');
    });
  });

  describe('code blocks', () => {
    it('emits code block as single unit with code_block boundary', () => {
      const chunks = collect('Here is code:\n```\nconst x = 1;\nconst y = 2;\n```\nDone here.');
      const boundaries = chunks.map((c) => c.boundary);
      expect(boundaries).toContain('code_block');
      const codeChunk = chunks.find((c) => c.boundary === 'code_block')!;
      expect(codeChunk.text).toContain('const x = 1;');
      expect(codeChunk.text).toContain('const y = 2;');
    });

    it('code blocks with many newlines do not flush per line', () => {
      const chunks = collectBeforeFlush('```\nline1\nline2\nline3\nline4\nline5\n```\n');
      // Should be one code_block chunk, not 5 newline chunks
      const codeChunks = chunks.filter((c) => c.boundary === 'code_block');
      const newlineChunks = chunks.filter((c) => c.boundary === 'newline');
      expect(codeChunks.length).toBe(1);
      expect(newlineChunks.length).toBe(0);
    });

    it('handles code block split across incremental pushes', () => {
      const chunks: Chunk[] = [];
      const chunker = new ProseChunker((c) => chunks.push(c));
      chunker.push('Before. ```\ncode line 1');
      chunker.push('\ncode line 2\n```');
      chunker.push('\nAfter code.');
      chunker.flush();
      expect(chunks.length).toBe(3);
      expect(chunks[1].boundary).toBe('code_block');
    });
  });

  describe('hard cap', () => {
    it('forces a chunk when buffered text exceeds max size', () => {
      // 350 chars with no boundaries
      const longText = 'a'.repeat(350);
      const chunks = collectBeforeFlush(longText);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].boundary).toBe('hard_cap');
    });

    it('long prose with no newline still speaks due to hard cap', () => {
      // Long text with no newlines, no sentence boundaries
      const longText =
        'this is a very long piece of text that just keeps going and going without any sentence ending punctuation or newline characters and it just continues on and on without stopping for anything at all just running text that goes on forever and ever without a break in sight continuing endlessly through the buffer without any sort of boundary whatsoever just pure unbroken text';
      const chunks = collectBeforeFlush(longText);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // At least one chunk should have been forced out
      expect(chunks.some((c) => c.boundary === 'hard_cap')).toBe(true);
    });

    it('splits at weak boundary (comma/semicolon) when possible', () => {
      // Long text with commas but no sentence boundaries
      const parts = [];
      for (let i = 0; i < 20; i++) {
        parts.push(`part ${i} of the text`);
      }
      const longText = parts.join(', ');
      const chunks = collectBeforeFlush(longText);
      if (chunks.length > 0) {
        // Should split at a comma, not in the middle of a word
        expect(chunks[0].text.endsWith(',')).toBe(true);
      }
    });
  });

  describe('drain', () => {
    it('returns remaining buffered text without emitting', () => {
      const chunks: Chunk[] = [];
      const chunker = new ProseChunker((c) => chunks.push(c));
      chunker.push('partial text without ending');
      const remaining = chunker.drain();
      expect(remaining).toBe('partial text without ending');
      expect(chunks.length).toBe(0); // no chunks emitted
    });

    it('returns null when buffer is empty', () => {
      const chunker = new ProseChunker(() => {});
      expect(chunker.drain()).toBeNull();
    });

    it('clears buffer after drain', () => {
      const chunker = new ProseChunker(() => {});
      chunker.push('some text');
      chunker.drain();
      expect(chunker.drain()).toBeNull();
    });
  });

  describe('flush', () => {
    it('emits remaining buffer with flush boundary', () => {
      const chunks = collect('partial text without ending');
      expect(chunks).toEqual([{ text: 'partial text without ending', boundary: 'flush' }]);
    });

    it('empty input produces no chunks', () => {
      const chunks = collect('');
      expect(chunks).toEqual([]);
    });
  });

  describe('incremental feeding', () => {
    it('handles char-by-char input', () => {
      const text = 'Hello world.\nNext line.';
      const chunks: Chunk[] = [];
      const chunker = new ProseChunker((c) => chunks.push(c));
      for (const ch of text) {
        chunker.push(ch);
      }
      chunker.flush();
      // Should have at least the newline-split chunk
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.boundary === 'newline')).toBe(true);
    });
  });

  describe('mixed boundaries', () => {
    it('handles prose with newlines and sentences', () => {
      const chunks = collect(
        'First line here now.\nSecond sentence on new line. Third stays buffered.',
      );
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // First chunk should be newline-triggered
      expect(chunks[0].boundary).toBe('newline');
    });
  });
});
