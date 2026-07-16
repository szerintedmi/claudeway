import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import {
  channelBusy,
  isMessageProcessing,
  MAX_CONCURRENT_PROCESSES,
  drainChannel,
} from '../core/engine.js';
import type { ChannelResponder, IStreamingResponder } from '../core/interfaces.js';
import type { Config, UserPermissions } from '../config.js';

// --- Mock responder factory ---

function makeMockStreamingResponder(): IStreamingResponder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onTextDelta: () => {
      calls.push('sr.onTextDelta');
    },
    onToolEvent: () => {
      calls.push('sr.onToolEvent');
    },
    finish: async () => {
      calls.push('sr.finish');
    },
    getFullText: () => 'mock text',
  };
}

function makeMockResponder(): ChannelResponder & { calls: string[]; warnings: string[] } {
  const calls: string[] = [];
  const warnings: string[] = [];
  const sr = makeMockStreamingResponder();
  return {
    calls,
    warnings,
    onProcessing: async () => {
      calls.push('onProcessing');
    },
    onComplete: async () => {
      calls.push('onComplete');
    },
    onError: async (msg) => {
      calls.push(`onError:${msg}`);
    },
    sendResponse: async (text) => {
      calls.push(`sendResponse:${text.substring(0, 20)}`);
    },
    createStreamingResponder: () => {
      calls.push('createStreamingResponder');
      return sr;
    },
    onStreamComplete: async () => {
      calls.push('onStreamComplete');
    },
    uploadFile: async () => {
      calls.push('uploadFile');
    },
    warn: async (msg) => {
      calls.push('warn');
      warnings.push(msg);
    },
  };
}

// --- Tests for exported utilities (no mocking needed) ---

describe('channelBusy', () => {
  beforeEach(() => {
    channelBusy.clear();
  });

  it('is a Set that tracks busy channels', () => {
    expect(channelBusy.has('C001')).toBe(false);
    channelBusy.add('C001');
    expect(channelBusy.has('C001')).toBe(true);
    channelBusy.delete('C001');
    expect(channelBusy.has('C001')).toBe(false);
  });
});

describe('isMessageProcessing', () => {
  it('returns false for untracked messages', () => {
    expect(isMessageProcessing('C001', '123.456')).toBe(false);
  });
});

describe('MAX_CONCURRENT_PROCESSES', () => {
  it('is 8', () => {
    expect(MAX_CONCURRENT_PROCESSES).toBe(8);
  });
});

describe('drainChannel', () => {
  beforeEach(() => {
    channelBusy.clear();
  });

  it('adds channelId to channelBusy during drain and removes after', async () => {
    // Factory that returns a mock responder — but since the queue is empty,
    // processQueuedMessage is never called
    const factory = () => makeMockResponder();

    expect(channelBusy.has('C_DRAIN')).toBe(false);

    // drainChannel should immediately add, then remove since queue is empty for this channel
    await drainChannel('C_DRAIN', factory);

    expect(channelBusy.has('C_DRAIN')).toBe(false);
  });

  it('removes channelId from channelBusy even if factory throws', async () => {
    const factory = () => {
      throw new Error('factory error');
    };

    try {
      await drainChannel('C_ERR', factory);
    } catch {
      // expected
    }

    // channelBusy must be cleaned up regardless
    expect(channelBusy.has('C_ERR')).toBe(false);
  });
});

// --- Streaming-runner answer classification (batch delivery source) ---

// Stub the spawn seam so runClaudeStreaming can be driven with scripted NDJSON
// lines instead of a real `claude` child. bun's mock.module patches the
// already-imported binding inside claude.ts. IMPORTANT: all claude-runner
// tests must mock THIS seam (child-processes.js); never whole-module-mock
// ../claude.js — bun cannot truly un-mock a module, so a re-registered frozen
// namespace permanently severs the claude.js → child-processes.js edge and
// poisons every later test file in the process.
let fakeClaudeScript: string[] = [];
mock.module('../child-processes.js', () => ({
  spawnTrackedClaude: () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (line: string, cb?: (err?: Error) => void) => boolean };
      kill: (sig?: string) => void;
      pid: number;
      killed: boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // The persistent runner writes the user message to stdin; accept and ack.
    proc.stdin = {
      write: (_line, cb) => {
        cb?.();
        return true;
      },
    };
    proc.kill = () => {};
    proc.pid = 4242;
    proc.killed = false;
    const lines = fakeClaudeScript;
    // setTimeout(0) lands after the runner has installed its turn state (the
    // persistent path sets currentTurn synchronously in the spawn tick).
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'));
      proc.emit('close', 0);
    }, 0);
    return proc;
  },
}));

describe('runClaudeStreaming answer classification (batch source)', () => {
  // Realistic stream shapes: the CLI wraps EVERY content block — text blocks
  // included — in content_block_start/content_block_stop at its index, and
  // parseStreamLine maps every content_block_stop to `tool_stop` (block type is
  // not recoverable at stop). Only an accumulator hit at that index identifies
  // a real tool; a text block's own stop must NOT clear the classifier's run.
  const textBlockStart = (index: number) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    });
  const delta = (text: string, index: number) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    });
  const toolStart = (name: string, index: number) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name } },
    });
  const blockStop = (index: number) =>
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index } });
  const subagentDone = (summary: string) =>
    JSON.stringify({ type: 'system', subtype: 'task_notification', status: 'completed', summary });
  const resultLine = (text: string) =>
    JSON.stringify({ type: 'result', result: text, session_id: 's1', cost_usd: 0 });

  // Precomputed `session` skips filesystem session resolution; the fake spawn
  // never touches cwd. Config/permissions are the minimal shapes the env
  // allowlist reads.
  const streamOpts = (channelId = 'C_BATCH') => ({
    message: 'hello',
    cwd: '/tmp',
    model: 'sonnet',
    systemPrompt: 'sys',
    timeoutMs: 5000,
    channelId,
    config: { env: [], permissions: {} } as unknown as Config,
    userPermissions: [] as unknown as UserPermissions,
    userId: 'u1',
    session: { sessionId: '00000000-0000-0000-0000-000000000000', cwd: '/tmp', resuming: false },
    onTextDelta: () => {},
  });

  it('drops pre-tool narration and joins subagent-completed blocks into answerText', async () => {
    const { runClaudeStreaming } = await import('../claude.js');
    fakeClaudeScript = [
      textBlockStart(0),
      delta('narr', 0), // run ended by a real tool → narration, dropped
      blockStop(0),
      toolStart('Read', 1),
      blockStop(1),
      textBlockStart(2),
      delta('Block A', 2), // run ended by subagent_completed → answer block, kept
      blockStop(2), // TEXT block stop — must NOT erase the run before the completion
      subagentDone('background task finished'),
      textBlockStart(3),
      delta('Block B', 3), // final block = result text
      blockStop(3),
      resultLine('Block B'),
    ];
    const result = await runClaudeStreaming(streamOpts());
    expect(result.answerText).toBe('Block A\n\nBlock B');
    expect(result.response).toBe('Block B');
  });

  it('does not duplicate a straggler-completed final block in answerText', async () => {
    const { runClaudeStreaming } = await import('../claude.js');
    // A subagent_completed lands right before the run ends: the final answer is
    // pushed as an answer block AND returned as the result text — kept once.
    fakeClaudeScript = [
      textBlockStart(0),
      delta('Block C', 0),
      blockStop(0),
      subagentDone('done'),
      resultLine('Block C'),
    ];
    const result = await runClaudeStreaming(streamOpts());
    expect(result.answerText).toBe('Block C');
    expect(result.response).toBe('Block C');
  });

  it('persistent clean exit without a result event resolves with classifier-built answerText', async () => {
    const { runClaudePersistentStreaming } = await import('../claude.js');
    fakeClaudeScript = [
      textBlockStart(0),
      delta('narration before tool', 0), // ended by a real tool → dropped
      blockStop(0),
      toolStart('Read', 1),
      blockStop(1),
      textBlockStart(2),
      delta('Block A', 2),
      blockStop(2), // text block stop — run survives to the completion below
      subagentDone('background task finished'),
      textBlockStart(3),
      delta('Block B', 3),
      blockStop(3),
      // NO result event: the process closes cleanly mid-turn — the fallback
      // resolve must still carry the classifier's answerText, not raw fullText.
    ];
    const result = await runClaudePersistentStreaming(streamOpts('C_PERSIST'));
    expect(result.answerText).toBe('Block A\n\nBlock B');
    // The raw fullText fallback (`response`) keeps the narration.
    expect(result.response).toBe('narration before tool\n\nBlock A\n\nBlock B');
  });
});

describe('mock responder interface', () => {
  it('tracks calls in order', async () => {
    const r = makeMockResponder();
    await r.onProcessing();
    await r.sendResponse('hello world');
    await r.onComplete();
    expect(r.calls).toEqual(['onProcessing', 'sendResponse:hello world', 'onComplete']);
  });

  it('tracks error path', async () => {
    const r = makeMockResponder();
    await r.onProcessing();
    await r.onError('something failed');
    expect(r.calls).toEqual(['onProcessing', 'onError:something failed']);
  });

  it('tracks streaming path', async () => {
    const r = makeMockResponder();
    await r.onProcessing();
    const sr = r.createStreamingResponder();
    sr.onTextDelta('chunk');
    await sr.finish();
    await r.onStreamComplete('chunk', sr);
    await r.onComplete();
    expect(r.calls).toEqual([
      'onProcessing',
      'createStreamingResponder',
      'onStreamComplete',
      'onComplete',
    ]);
  });

  it('tracks warn and uploadFile', async () => {
    const r = makeMockResponder();
    await r.uploadFile('/tmp/file.txt');
    await r.warn('something went wrong');
    expect(r.calls).toEqual(['uploadFile', 'warn']);
    expect(r.warnings).toEqual(['something went wrong']);
  });
});
