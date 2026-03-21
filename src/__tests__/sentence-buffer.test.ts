import { describe, it, expect } from 'bun:test';
import { SentenceBuffer } from '../core/sentence-buffer.js';

function collect(input: string | string[]): string[] {
  const sentences: string[] = [];
  const buf = new SentenceBuffer((s) => sentences.push(s));
  if (Array.isArray(input)) {
    for (const chunk of input) buf.push(chunk);
  } else {
    buf.push(input);
  }
  buf.flush();
  return sentences;
}

describe('SentenceBuffer', () => {
  it('splits on period followed by whitespace', () => {
    const sentences = collect(
      'This is the first sentence here. This is the second sentence now. And this is a third sentence too.',
    );
    expect(sentences).toEqual([
      'This is the first sentence here.',
      'This is the second sentence now.',
      'And this is a third sentence too.',
    ]);
  });

  it('splits on question mark', () => {
    const sentences = collect('What is going on here? I have no idea about this.');
    expect(sentences).toEqual(['What is going on here?', 'I have no idea about this.']);
  });

  it('splits on exclamation mark', () => {
    const sentences = collect('This is amazing and great! I love it so very much.');
    expect(sentences).toEqual(['This is amazing and great!', 'I love it so very much.']);
  });

  it('flushes partial buffer on stream end', () => {
    const sentences: string[] = [];
    const buf = new SentenceBuffer((s) => sentences.push(s));
    buf.push('This has no ending punctuation');
    buf.flush();
    expect(sentences).toEqual(['This has no ending punctuation']);
  });

  it('handles ellipsis without splitting', () => {
    const sentences = collect('I was thinking... maybe we should try a different approach here.');
    expect(sentences).toEqual(['I was thinking... maybe we should try a different approach here.']);
  });

  it('handles abbreviations without splitting', () => {
    const sentences = collect('Dr. Smith went to the store e.g. the grocery. Then he left.');
    expect(sentences).toEqual(['Dr. Smith went to the store e.g. the grocery.', 'Then he left.']);
  });

  it('handles decimals without splitting', () => {
    const sentences = collect('The value is 3.14 which is approximately pi. That is correct.');
    expect(sentences).toEqual(['The value is 3.14 which is approximately pi.', 'That is correct.']);
  });

  it('handles code blocks as single unit', () => {
    const sentences = collect(
      'Here is code:\n```\nconst x = 1;\nconst y = 2;\n```\nThat was the code example.',
    );
    expect(sentences).toEqual([
      'Here is code:',
      '```\nconst x = 1;\nconst y = 2;\n```\n',
      'That was the code example.',
    ]);
  });

  it('handles incremental feeding (char by char)', () => {
    const text = 'Hello world. This is a sentence.';
    const sentences: string[] = [];
    const buf = new SentenceBuffer((s) => sentences.push(s));
    for (const ch of text) {
      buf.push(ch);
    }
    buf.flush();
    // "Hello world." is only 12 chars, below min length — gets combined
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.join(' ')).toContain('Hello world');
  });

  it('enforces minimum sentence length', () => {
    // "Hi." is 3 chars, well below the 20-char minimum
    const sentences = collect('Hi. This is a much longer sentence that should be emitted.');
    // "Hi." is too short, so it gets combined with the next sentence
    expect(sentences.length).toBe(1);
    expect(sentences[0]).toContain('Hi.');
    expect(sentences[0]).toContain('longer sentence');
  });

  it('handles empty input', () => {
    const sentences = collect('');
    expect(sentences).toEqual([]);
  });

  it('handles input with no sentence boundaries', () => {
    const sentences = collect('just a fragment with no ending');
    expect(sentences).toEqual(['just a fragment with no ending']);
  });

  it('handles multiple flushes', () => {
    const sentences: string[] = [];
    const buf = new SentenceBuffer((s) => sentences.push(s));
    buf.push('First sentence here now.');
    buf.flush();
    buf.push(' Second sentence here now.');
    buf.flush();
    expect(sentences).toEqual(['First sentence here now.', 'Second sentence here now.']);
  });

  it('handles code block split across chunks', () => {
    const sentences: string[] = [];
    const buf = new SentenceBuffer((s) => sentences.push(s));
    buf.push('Before code. ```\ncode line 1');
    buf.push('\ncode line 2\n```');
    buf.push(' After code is done here.');
    buf.flush();
    expect(sentences.length).toBe(3);
    expect(sentences[0]).toBe('Before code.');
    expect(sentences[1]).toContain('```');
    expect(sentences[1]).toContain('code line 1');
    expect(sentences[2]).toContain('After code');
  });
});
