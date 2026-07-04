/**
 * Prose chunker for TTS streaming.
 *
 * Buffers text from onTextDelta and emits chunks with boundary metadata.
 * Boundary types control flush policy in the TTS responder:
 *
 * - 'newline'    — \n or \n\n in prose (suppressed inside code blocks)
 * - 'sentence'   — . ? ! followed by whitespace
 * - 'hard_cap'   — buffered text exceeds max size without any boundary
 * - 'code_block' — complete ``` ... ``` block
 * - 'flush'      — end of turn (explicit flush() call)
 */

const ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'ave.',
  'blvd.',
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'approx.',
  'dept.',
  'est.',
  'govt.',
  'inc.',
  'ltd.',
  'no.',
  'vol.',
  'fig.',
  'ref.',
]);

const MIN_SENTENCE_LENGTH = 20;
const HARD_CAP = 300;

export type ChunkBoundary = 'newline' | 'sentence' | 'hard_cap' | 'code_block' | 'flush';

export interface Chunk {
  text: string;
  boundary: ChunkBoundary;
}

export type ChunkCallback = (chunk: Chunk) => void;

export class ProseChunker {
  private buffer = '';
  private inCodeBlock = false;
  private onChunk: ChunkCallback;

  constructor(onChunk: ChunkCallback) {
    this.onChunk = onChunk;
  }

  /** Feed incremental text (from onTextDelta) */
  push(text: string): void {
    this.buffer += text;
    this.processBoundaries();
  }

  /**
   * Return any remaining buffered text and clear the buffer.
   * Does not emit a chunk — the caller decides how to handle the trailing text.
   */
  drain(): string | null {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    this.inCodeBlock = false;
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Flush any remaining buffered text as a chunk (for SentenceBuffer compat) */
  flush(): void {
    const remaining = this.drain();
    if (remaining) {
      this.onChunk({ text: remaining, boundary: 'flush' });
    }
  }

  private emit(text: string, boundary: ChunkBoundary): void {
    // Don't trim code blocks — preserve internal whitespace/newlines
    const output = boundary === 'code_block' ? text : text.trim();
    if (output.length > 0) {
      this.onChunk({ text: output, boundary });
    }
  }

  private processBoundaries(): void {
    for (;;) {
      // --- Code block handling ---
      const codeBlockIdx = this.buffer.indexOf('```');
      if (codeBlockIdx !== -1) {
        if (!this.inCodeBlock) {
          // Emit any text before the code block
          const before = this.buffer.slice(0, codeBlockIdx);
          if (before.trim().length > 0) {
            this.emitProse(before);
          }
          this.inCodeBlock = true;
          this.buffer = this.buffer.slice(codeBlockIdx);

          // Check if closing ``` exists
          const closeIdx = this.buffer.indexOf('```', 3);
          if (closeIdx !== -1) {
            const endIdx = this.buffer.indexOf('\n', closeIdx + 3);
            const blockEnd = endIdx !== -1 ? endIdx + 1 : closeIdx + 3;
            const block = this.buffer.slice(0, blockEnd);
            this.emit(block, 'code_block');
            this.buffer = this.buffer.slice(blockEnd);
            this.inCodeBlock = false;
            continue;
          }
          return; // Wait for closing ```
        } else {
          const closeIdx = this.buffer.indexOf('```', 3);
          if (closeIdx !== -1) {
            const endIdx = this.buffer.indexOf('\n', closeIdx + 3);
            const blockEnd = endIdx !== -1 ? endIdx + 1 : closeIdx + 3;
            const block = this.buffer.slice(0, blockEnd);
            this.emit(block, 'code_block');
            this.buffer = this.buffer.slice(blockEnd);
            this.inCodeBlock = false;
            continue;
          }
          return; // Still waiting for closing ```
        }
      }

      if (this.inCodeBlock) {
        return; // No closing ``` found yet
      }

      // --- Prose handling: check boundaries in priority order ---

      // 1. Newline boundary (strong) — \n or \n\n
      const nlIdx = this.buffer.indexOf('\n');
      if (nlIdx !== -1) {
        // Find end of consecutive newlines
        let endNl = nlIdx;
        while (endNl + 1 < this.buffer.length && this.buffer[endNl + 1] === '\n') {
          endNl++;
        }
        const chunk = this.buffer.slice(0, endNl + 1);
        this.buffer = this.buffer.slice(endNl + 1);
        const trimmed = chunk.trim();
        if (trimmed.length > 0) {
          this.onChunk({ text: trimmed, boundary: 'newline' });
        }
        continue;
      }

      // 2. Sentence boundary (normal) — .?! followed by whitespace
      const sentEnd = this.findSentenceBoundary();
      if (sentEnd !== -1) {
        const chunk = this.buffer.slice(0, sentEnd);
        this.buffer = this.buffer.slice(sentEnd);
        const trimmed = chunk.trim();
        if (trimmed.length >= MIN_SENTENCE_LENGTH) {
          this.onChunk({ text: trimmed, boundary: 'sentence' });
          continue;
        } else if (trimmed.length > 0) {
          // Too short — prepend back for combining with next
          this.buffer = trimmed + this.buffer;
          return;
        }
        continue;
      }

      // 3. Hard cap fallback — force a chunk if buffer is too large
      if (this.buffer.length >= HARD_CAP) {
        // Try to split at a weak boundary (, ; :) or last space
        const splitAt = this.findWeakBoundary(HARD_CAP) ?? this.findLastSpace(HARD_CAP);
        if (splitAt !== null && splitAt > 0) {
          const chunk = this.buffer.slice(0, splitAt);
          this.buffer = this.buffer.slice(splitAt);
          this.emit(chunk, 'hard_cap');
          continue;
        }
        // No good split point — just emit the whole thing
        const chunk = this.buffer.slice(0, HARD_CAP);
        this.buffer = this.buffer.slice(HARD_CAP);
        this.emit(chunk, 'hard_cap');
        continue;
      }

      // No boundary found and under hard cap — wait for more input
      return;
    }
  }

  /** Emit prose text, checking for any embedded boundaries */
  private emitProse(text: string): void {
    // The text before a code block might have newlines or sentences.
    // Push it back through the drain logic.
    const oldBuffer = this.buffer;
    this.buffer = text;
    this.processBoundaries();
    // Anything still in buffer after processBoundaries = no boundary found, emit as-is
    if (this.buffer.trim().length > 0) {
      this.emit(this.buffer, 'sentence');
    }
    this.buffer = oldBuffer;
  }

  private findSentenceBoundary(): number {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      const ch = this.buffer[i];
      const next = this.buffer[i + 1];

      if ((ch === '.' || ch === '?' || ch === '!') && /\s/.test(next)) {
        // Skip ellipsis
        if (ch === '.' && i >= 2 && this.buffer[i - 1] === '.' && this.buffer[i - 2] === '.') {
          continue;
        }
        // (No decimal-skip needed: the `\s` test above already means `next` is
        // whitespace, so a "3.14" dot — followed by a digit — is never a
        // candidate boundary in the first place.)
        // Skip abbreviations
        if (ch === '.' && this.isAbbreviation(i)) {
          continue;
        }
        return i + 1;
      }
    }
    return -1;
  }

  private isAbbreviation(dotIndex: number): boolean {
    let start = dotIndex;
    while (start > 0 && /[a-zA-Z.]/.test(this.buffer[start - 1])) {
      start--;
    }
    const word = this.buffer.slice(start, dotIndex + 1).toLowerCase();
    return ABBREVIATIONS.has(word);
  }

  /** Find the last weak boundary (, ; :) before maxLen */
  private findWeakBoundary(maxLen: number): number | null {
    const limit = Math.min(maxLen, this.buffer.length);
    for (let i = limit - 1; i > 0; i--) {
      const ch = this.buffer[i];
      if (
        (ch === ',' || ch === ';' || ch === ':') &&
        i + 1 < this.buffer.length &&
        /\s/.test(this.buffer[i + 1])
      ) {
        return i + 1;
      }
    }
    return null;
  }

  /** Find the last space before maxLen */
  private findLastSpace(maxLen: number): number | null {
    const limit = Math.min(maxLen, this.buffer.length);
    for (let i = limit - 1; i > 0; i--) {
      if (this.buffer[i] === ' ') {
        return i + 1;
      }
    }
    return null;
  }
}

/**
 * Backward-compatible wrapper: emits plain strings like the old SentenceBuffer.
 * Used by code that doesn't need boundary metadata.
 */
export type SentenceCallback = (sentence: string) => void;

export class SentenceBuffer {
  private chunker: ProseChunker;

  constructor(onSentence: SentenceCallback) {
    this.chunker = new ProseChunker((chunk) => onSentence(chunk.text));
  }

  push(text: string): void {
    this.chunker.push(text);
  }

  flush(): void {
    this.chunker.flush();
  }
}
