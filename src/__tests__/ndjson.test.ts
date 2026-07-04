import { parseStreamLine } from '../claude.js';
import { ToolUseAccumulators } from '../claude-stream-parser.js';

describe('parseStreamLine — text_delta events', () => {
  const makeDelta = (text: string) =>
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });

  it('extracts text from a well-formed text_delta event', () => {
    expect(parseStreamLine(makeDelta('Hello'))).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('handles unicode text', () => {
    expect(parseStreamLine(makeDelta('こんにちは 🎉'))).toEqual({
      type: 'text_delta',
      text: 'こんにちは 🎉',
    });
  });

  it('handles multi-line text in a single delta', () => {
    const text = 'line one\nline two\nline three';
    expect(parseStreamLine(makeDelta(text))).toEqual({ type: 'text_delta', text });
  });

  it('returns null for empty lines', () => {
    expect(parseStreamLine('')).toBeNull();
  });

  it('returns null for whitespace-only lines', () => {
    expect(parseStreamLine('   \t  ')).toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseStreamLine('not json at all')).toBeNull();
  });

  it('returns null when event.type is not content_block_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', delta: { type: 'text_delta', text: 'hi' } },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns tool_input_delta when delta.type is input_json_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'tool_input_delta',
      partialJson: '{}',
      index: 1,
    });
  });

  it('returns null when delta.text is empty string', () => {
    expect(parseStreamLine(makeDelta(''))).toBeNull();
  });

  it('returns null when delta.text is missing', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null for unknown top-level type', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'ping' }))).toBeNull();
  });
});

describe('parseStreamLine — reasoning (thinking) deltas', () => {
  const makeThinking = (thinking: string) =>
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking },
      },
    });

  it('extracts thinking text as a reasoning_delta event', () => {
    expect(parseStreamLine(makeThinking('Let me reason'))).toEqual({
      type: 'reasoning_delta',
      text: 'Let me reason',
    });
  });

  it('returns null for an empty thinking delta', () => {
    expect(parseStreamLine(makeThinking(''))).toBeNull();
  });

  it('ignores signature_delta (no thinking text to surface)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQB...' },
      },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('does not confuse reasoning with answer text', () => {
    const reasoning = parseStreamLine(makeThinking('thinking aloud'));
    expect(reasoning).toEqual({ type: 'reasoning_delta', text: 'thinking aloud' });
  });
});

describe('parseStreamLine — result events', () => {
  it('extracts session_id, cost_usd, and result text', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'The answer is 42',
      session_id: 'abc-123',
      cost_usd: 0.0042,
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'result',
      text: 'The answer is 42',
      sessionId: 'abc-123',
      cost: 0.0042,
      tokens: null,
    });
  });

  it('falls back to total_cost_usd when cost_usd is absent', () => {
    const line = JSON.stringify({
      type: 'result',
      result: '',
      session_id: 'x',
      total_cost_usd: 0.1,
    });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.cost).toBe(0.1);
  });

  it('returns null session_id when session_id is absent', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', cost_usd: 0.01 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.sessionId).toBeNull();
  });

  it('returns null cost when neither cost field is present', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', session_id: 'x' });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.cost).toBeNull();
  });

  it('returns empty string for result text when result field is absent', () => {
    const line = JSON.stringify({ type: 'result', session_id: 'x', cost_usd: 0 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.text).toBe('');
  });

  it('sums input_tokens + output_tokens from usage field', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'hi',
      session_id: 'x',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.tokens).toBe(150);
  });

  it('returns null tokens when usage field is absent', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', session_id: 'x', cost_usd: 0.01 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.tokens).toBeNull();
  });
});

describe('parseStreamLine — user_receipt', () => {
  it('returns user_receipt for persistent mode echo', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(parseStreamLine(line)).toEqual({ type: 'user_receipt' });
  });
});

describe('parseStreamLine — tool events', () => {
  it('returns tool_start for content_block_start with tool_use', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'Read', input: {} },
      },
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'tool_start',
      toolName: 'Read',
      index: 1,
    });
  });

  it('returns tool_start with unknown for missing name', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_123' },
      },
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'tool_start',
      toolName: 'unknown',
      index: 1,
    });
  });

  it('returns null for content_block_start with text type', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns tool_input_delta for input_json_delta events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/' },
      },
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'tool_input_delta',
      partialJson: '{"file_path":"src/',
      index: 1,
    });
  });

  it('returns tool_stop for content_block_stop with index', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    });
    expect(parseStreamLine(line)).toEqual({ type: 'tool_stop', index: 1 });
  });
});

describe('ToolUseAccumulators — overlapping tool blocks', () => {
  it('accumulates and closes interleaved blocks independently', () => {
    const accums = new ToolUseAccumulators();
    accums.start('Read', 0);
    accums.start('Bash', 1); // starts before index 0 stops
    accums.appendInput(0, '{"file_path":"a.ts"}');
    accums.appendInput(1, '{"command":"ls"}');
    // Stops arrive out of order; each returns its own block, none dropped.
    const first = accums.stop(0);
    expect(first).toEqual({ toolName: 'Read', partialJson: '{"file_path":"a.ts"}', index: 0 });
    const second = accums.stop(1);
    expect(second).toEqual({ toolName: 'Bash', partialJson: '{"command":"ls"}', index: 1 });
  });

  it('ignores stops for non-tool blocks and double stops', () => {
    const accums = new ToolUseAccumulators();
    expect(accums.stop(0)).toBeNull(); // text block's content_block_stop
    accums.start('Read', 1);
    expect(accums.stop(1)?.toolName).toBe('Read');
    expect(accums.stop(1)).toBeNull(); // already closed
    accums.appendInput(1, '{}'); // append after close is a no-op, no throw
  });
});

describe('parseStreamLine — robustness', () => {
  it('does not throw on truncated JSON', () => {
    expect(() => parseStreamLine('{"type":"stream_event","event":')).not.toThrow();
    expect(parseStreamLine('{"type":"stream_event","event":')).toBeNull();
  });

  it('does not throw on deeply wrong shapes', () => {
    expect(() =>
      parseStreamLine(JSON.stringify({ type: 'stream_event', event: null })),
    ).not.toThrow();
  });

  it('returns null for assistant events without matching shape', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } });
    expect(parseStreamLine(line)).toBeNull();
  });
});

describe('parseStreamLine — subagent events', () => {
  it('parses task_progress system event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'abc123',
      tool_use_id: 'toolu_xyz',
      description: 'Running search for markdown files',
      last_tool_name: 'Bash',
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'subagent_progress',
      description: 'Running search for markdown files',
      toolName: 'Bash',
    });
  });

  it('parses task_notification completed system event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'abc123',
      tool_use_id: 'toolu_xyz',
      status: 'completed',
      summary: 'Search .md files with fd',
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'subagent_completed',
      description: 'Search .md files with fd',
    });
  });

  it('ignores non-completed task_notification', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      status: 'started',
      task_id: 'abc',
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('ignores system events without task subtypes', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/tmp',
    });
    expect(parseStreamLine(line)).toBeNull();
  });
});
