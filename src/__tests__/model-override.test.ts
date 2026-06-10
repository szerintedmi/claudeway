import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { WebClient } from '@slack/web-api';
import { parseModelOverride, applyModelOverride } from '../adapters/slack/handler.js';
import { handleMagicCommand } from '../adapters/slack/commands.js';
import {
  enqueue,
  dequeue,
  getPending,
  updateQueuedMessage,
  ensureQueueDir,
  type QueuedMessage,
} from '../queue.js';

describe('parseModelOverride', () => {
  it('parses a simple alias', () => {
    expect(parseModelOverride('!model:opus refactor this')).toEqual({
      model: 'opus',
      rest: 'refactor this',
    });
  });

  it('parses a full model id', () => {
    expect(parseModelOverride('!model:claude-opus-4-8 deep review')).toEqual({
      model: 'claude-opus-4-8',
      rest: 'deep review',
    });
  });

  it('parses a bracketed model id', () => {
    expect(parseModelOverride('!model:claude-fable-5[1m] hi')).toEqual({
      model: 'claude-fable-5[1m]',
      rest: 'hi',
    });
  });

  it('returns empty rest when there is no message body', () => {
    expect(parseModelOverride('!model:opus')).toEqual({ model: 'opus', rest: '' });
  });

  it('ignores mid-message occurrences', () => {
    expect(parseModelOverride('please use !model:opus')).toBeNull();
  });

  it('rejects an empty model name', () => {
    expect(parseModelOverride('!model: hi')).toBeNull();
  });

  it('rejects trailing junk in the model name', () => {
    expect(parseModelOverride('!model:opus, hi')).toBeNull();
  });

  it('rejects option-like model names', () => {
    expect(parseModelOverride('!model:--verbose hi')).toBeNull();
  });

  it('tolerates leading whitespace and preserves multiline rest', () => {
    expect(parseModelOverride('  !model:haiku line one\nline two')).toEqual({
      model: 'haiku',
      rest: 'line one\nline two',
    });
  });
});

describe('applyModelOverride', () => {
  it('strips the override and keeps the bot mention', () => {
    expect(applyModelOverride('<@BOT> !model:opus do x', 'BOT')).toEqual({
      text: '<@BOT> do x',
      modelOverride: 'opus',
    });
  });

  it('works without a mention (direct-respond channels)', () => {
    expect(applyModelOverride('!model:sonnet do x', 'BOT')).toEqual({
      text: 'do x',
      modelOverride: 'sonnet',
    });
  });

  it('leaves text unchanged when there is no override', () => {
    expect(applyModelOverride('<@BOT> just a message', 'BOT')).toEqual({
      text: '<@BOT> just a message',
    });
  });

  it('does not treat an override after other text as an override', () => {
    expect(applyModelOverride('<@BOT> tell me about !model:opus syntax', 'BOT')).toEqual({
      text: '<@BOT> tell me about !model:opus syntax',
    });
  });

  it('keeps only the mention when the override has no body', () => {
    expect(applyModelOverride('<@BOT> !model:opus', 'BOT')).toEqual({
      text: '<@BOT> ',
      modelOverride: 'opus',
    });
  });
});

describe('magic-command non-interception', () => {
  const stubClient = {} as WebClient;

  it('does not intercept a bare override', async () => {
    expect(await handleMagicCommand('!model:opus', 'C001', 'ts', 'ts', 'U001', stubClient)).toBe(
      false,
    );
  });

  it('does not intercept an override with a message', async () => {
    expect(
      await handleMagicCommand('!model:opus do x', 'C001', 'ts', 'ts', 'U001', stubClient),
    ).toBe(false);
  });
});

describe('queue modelOverride persistence', () => {
  const channelId = 'CMODELQUEUE';
  const ts = '1.000001';

  const baseMsg: QueuedMessage = {
    channelId,
    userId: 'U001',
    text: 'do x',
    ts,
    threadTs: ts,
    queuedAt: new Date().toISOString(),
  };

  beforeAll(() => {
    ensureQueueDir();
  });

  afterAll(() => {
    dequeue(channelId, ts);
  });

  it('round-trips modelOverride through enqueue/getPending', () => {
    enqueue({ ...baseMsg, modelOverride: 'opus' });
    const found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.modelOverride).toBe('opus');
  });

  it('updateQueuedMessage replaces the override', () => {
    enqueue({ ...baseMsg, modelOverride: 'opus' });
    expect(updateQueuedMessage(channelId, ts, { text: 'do y', modelOverride: 'haiku' })).toBe(true);
    const found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.text).toBe('do y');
    expect(found?.modelOverride).toBe('haiku');
  });

  it('updateQueuedMessage clears the override when omitted', () => {
    enqueue({ ...baseMsg, modelOverride: 'opus' });
    expect(updateQueuedMessage(channelId, ts, { text: 'do z' })).toBe(true);
    const found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.text).toBe('do z');
    expect(found?.modelOverride).toBeUndefined();
    expect(found && 'modelOverride' in found).toBe(false);
  });
});

describe('engine model resolution', () => {
  let tmpDir: string;
  const originalCwd = process.cwd;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let actualClaude: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capturedOpts: any[] = [];

  const configYaml = `
channels:
  CMODELBATCH:
    name: model-test-batch
    folder: /tmp
  CMODELSTREAM:
    name: model-test-stream
    folder: /tmp
    responseMode: stream-update
defaults:
  model: channel-default-model
  systemPrompt: test prompt
  timeoutMs: 300000
  responseMode: batch
`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeway-model-override-'));
    writeFileSync(join(tmpDir, 'config.yaml'), configYaml);
    process.cwd = () => tmpDir;

    actualClaude = await import('../claude.js');
    const fakeResult = { response: 'ok', sessionId: null, cost: null, tokens: null };
    mock.module('../claude.js', () => ({
      ...actualClaude,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runClaude: async (opts: any) => {
        capturedOpts.push(opts);
        return fakeResult;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runClaudeStreaming: async (opts: any) => {
        capturedOpts.push(opts);
        return fakeResult;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runClaudePersistentStreaming: async (opts: any) => {
        capturedOpts.push(opts);
        return fakeResult;
      },
    }));
  });

  afterAll(() => {
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore the real module for any test files that run after this one
    mock.module('../claude.js', () => actualClaude);
  });

  function makeResponder() {
    return {
      onProcessing: async () => {},
      onComplete: async () => {},
      onError: async (msg: string) => {
        throw new Error(`unexpected onError: ${msg}`);
      },
      sendResponse: async () => {},
      createStreamingResponder: () => ({
        onTextDelta: () => {},
        onToolEvent: () => {},
        finish: async () => {},
        getFullText: () => 'ok',
      }),
      onStreamComplete: async () => {},
      uploadFile: async () => {},
      warn: async () => {},
    };
  }

  function makeQueued(channelId: string, modelOverride?: string): QueuedMessage {
    return {
      channelId,
      userId: 'U001',
      text: 'do x',
      ts: `2.${Math.floor(performance.now() * 1000)}`,
      threadTs: '2.000001',
      queuedAt: new Date().toISOString(),
      ...(modelOverride ? { modelOverride } : {}),
    };
  }

  async function runWith(channelId: string, modelOverride?: string) {
    const { processQueuedMessage } = await import('../core/engine.js');
    capturedOpts.length = 0;
    await processQueuedMessage(makeQueued(channelId, modelOverride), makeResponder());
    expect(capturedOpts.length).toBe(1);
    return capturedOpts[0];
  }

  it('passes the override to the batch runner', async () => {
    const opts = await runWith('CMODELBATCH', 'override-model');
    expect(opts.model).toBe('override-model');
  });

  it('passes the override to the streaming runner', async () => {
    const opts = await runWith('CMODELSTREAM', 'override-model');
    expect(opts.model).toBe('override-model');
  });

  it('falls back to the channel/default model without an override', async () => {
    const batchOpts = await runWith('CMODELBATCH');
    expect(batchOpts.model).toBe('channel-default-model');
    const streamOpts = await runWith('CMODELSTREAM');
    expect(streamOpts.model).toBe('channel-default-model');
  });
});
