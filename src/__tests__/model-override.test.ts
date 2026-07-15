import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import {
  parseModelOverride,
  parseEffortOverride,
  applyOverrides,
} from '../adapters/slack/handler.js';
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

describe('parseEffortOverride', () => {
  it('parses a level and message body', () => {
    expect(parseEffortOverride('!effort:high refactor this')).toEqual({
      effort: 'high',
      rest: 'refactor this',
    });
  });

  it('lowercases the level', () => {
    expect(parseEffortOverride('!effort:HIGH do x')).toEqual({ effort: 'high', rest: 'do x' });
  });

  it('returns empty rest when there is no message body', () => {
    expect(parseEffortOverride('!effort:max')).toEqual({ effort: 'max', rest: '' });
  });

  it('captures an unknown value freeform (validation happens in the handler)', () => {
    expect(parseEffortOverride('!effort:turbo hi')).toEqual({ effort: 'turbo', rest: 'hi' });
  });

  it('ignores mid-message occurrences', () => {
    expect(parseEffortOverride('please use !effort:high')).toBeNull();
  });

  it('rejects option-like values', () => {
    expect(parseEffortOverride('!effort:--x hi')).toBeNull();
  });
});

describe('applyOverrides', () => {
  it('strips the model override and keeps the bot mention', () => {
    expect(applyOverrides('<@BOT> !model:opus do x', 'BOT')).toEqual({
      text: '<@BOT> do x',
      modelOverride: 'opus',
      effortOverride: undefined,
    });
  });

  it('works without a mention (direct-respond channels)', () => {
    expect(applyOverrides('!model:sonnet do x', 'BOT')).toEqual({
      text: 'do x',
      modelOverride: 'sonnet',
      effortOverride: undefined,
    });
  });

  it('leaves text unchanged when there is no override', () => {
    expect(applyOverrides('<@BOT> just a message', 'BOT')).toEqual({
      text: '<@BOT> just a message',
      modelOverride: undefined,
      effortOverride: undefined,
    });
  });

  it('does not treat an override after other text as an override', () => {
    expect(applyOverrides('<@BOT> tell me about !model:opus syntax', 'BOT')).toEqual({
      text: '<@BOT> tell me about !model:opus syntax',
      modelOverride: undefined,
      effortOverride: undefined,
    });
  });

  it('keeps only the mention when the override has no body', () => {
    expect(applyOverrides('<@BOT> !model:opus', 'BOT')).toEqual({
      text: '<@BOT> ',
      modelOverride: 'opus',
      effortOverride: undefined,
    });
  });

  it('strips an effort override', () => {
    expect(applyOverrides('<@BOT> !effort:high do x', 'BOT')).toEqual({
      text: '<@BOT> do x',
      modelOverride: undefined,
      effortOverride: 'high',
    });
  });

  it('combines model and effort overrides (model first)', () => {
    expect(applyOverrides('<@BOT> !model:opus !effort:high do x', 'BOT')).toEqual({
      text: '<@BOT> do x',
      modelOverride: 'opus',
      effortOverride: 'high',
    });
  });

  it('combines model and effort overrides (effort first)', () => {
    expect(applyOverrides('!effort:high !model:opus do x', 'BOT')).toEqual({
      text: 'do x',
      modelOverride: 'opus',
      effortOverride: 'high',
    });
  });

  it('applies only the first of a duplicated token', () => {
    expect(applyOverrides('!effort:low !effort:high x', 'BOT')).toEqual({
      text: '!effort:high x',
      modelOverride: undefined,
      effortOverride: 'low',
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

  it('does not intercept a bare effort override', async () => {
    expect(await handleMagicCommand('!effort:high', 'C001', 'ts', 'ts', 'U001', stubClient)).toBe(
      false,
    );
  });

  it('does not intercept an effort override with a message', async () => {
    expect(
      await handleMagicCommand('!effort:high do x', 'C001', 'ts', 'ts', 'U001', stubClient),
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

  it('updateQueuedMessage keeps slack.rawText in sync on structured entries', () => {
    enqueue({
      ...baseMsg,
      slack: { rawText: 'do x', senderId: 'U001', botUserId: 'UBOT' },
    });
    expect(updateQueuedMessage(channelId, ts, { text: 'edited text' })).toBe(true);
    const found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.text).toBe('edited text');
    expect(found?.slack?.rawText).toBe('edited text');
    expect(found?.slack?.senderId).toBe('U001');
  });

  it('round-trips and clears effortOverride', () => {
    enqueue({ ...baseMsg, effortOverride: 'high' });
    let found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.effortOverride).toBe('high');

    expect(updateQueuedMessage(channelId, ts, { text: 'do y', effortOverride: 'low' })).toBe(true);
    found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.effortOverride).toBe('low');

    expect(updateQueuedMessage(channelId, ts, { text: 'do z' })).toBe(true);
    found = getPending().find((m) => m.channelId === channelId && m.ts === ts);
    expect(found?.effortOverride).toBeUndefined();
    expect(found && 'effortOverride' in found).toBe(false);
  });
});

// Fake spawn seam for the engine-resolution tests below: the REAL engine and
// runner code runs end-to-end (config resolution → runClaudeStreaming →
// buildClaudeArgs), and only the child process is stubbed — the model/effort
// overrides are asserted on the actual CLI args handed to spawn. Claude-runner
// tests must mock THIS seam (child-processes.js); never whole-module-mock
// ../claude.js — bun cannot truly un-mock a module, so a frozen re-registered
// namespace permanently severs claude.js's own imports for every test file
// that runs later in the process.
const capturedSpawnArgs: string[][] = [];
mock.module('../child-processes.js', () => ({
  spawnTrackedClaude: (args: string[]) => {
    capturedSpawnArgs.push(args);
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: string) => void;
      pid: number;
      killed: boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    proc.pid = 4243;
    proc.killed = false;
    setTimeout(() => {
      proc.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', result: 'ok', cost_usd: 0 }) + '\n'),
      );
      proc.emit('close', 0);
    }, 0);
    return proc;
  },
}));

describe('engine model resolution', () => {
  let tmpDir: string;
  const originalCwd = process.cwd;

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
  effort: medium
  systemPrompt: test prompt
  timeoutMs: 300000
  responseMode: batch
`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeway-model-override-'));
    writeFileSync(join(tmpDir, 'config.yaml'), configYaml);
    process.cwd = () => tmpDir;

    // BYO Claude is always on: give the engine a secret store with an enrolled
    // token so the enrollment gate lets the test user through
    const { getSecretStore, resetSecretStoreForTests, secretsDir } = await import('../secrets.js');
    mkdirSync(secretsDir(tmpDir), { recursive: true });
    writeFileSync(join(secretsDir(tmpDir), 'key'), randomBytes(32).toString('hex'));
    resetSecretStoreForTests();
    getSecretStore(tmpDir).set('U001', 'claude', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test' });
  });

  afterAll(async () => {
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
    const { resetSecretStoreForTests } = await import('../secrets.js');
    resetSecretStoreForTests();
    // The child-processes fake stays registered (bun cannot un-mock a module);
    // it is inert for later files — nothing else spawns Claude for real.
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

  function makeQueued(
    channelId: string,
    overrides: { modelOverride?: string; effortOverride?: QueuedMessage['effortOverride'] } = {},
  ): QueuedMessage {
    return {
      channelId,
      userId: 'U001',
      text: 'do x',
      ts: `2.${Math.floor(performance.now() * 1000)}`,
      threadTs: '2.000001',
      queuedAt: new Date().toISOString(),
      ...(overrides.modelOverride ? { modelOverride: overrides.modelOverride } : {}),
      ...(overrides.effortOverride ? { effortOverride: overrides.effortOverride } : {}),
    };
  }

  /** Run one queued message through the REAL engine + runner; return the CLI
   *  args the runner handed to the (faked) spawn. */
  async function runWith(
    channelId: string,
    overrides: { modelOverride?: string; effortOverride?: QueuedMessage['effortOverride'] } = {},
  ): Promise<string[]> {
    const { processQueuedMessage } = await import('../core/engine.js');
    capturedSpawnArgs.length = 0;
    await processQueuedMessage(makeQueued(channelId, overrides), makeResponder());
    expect(capturedSpawnArgs.length).toBe(1);
    return capturedSpawnArgs[0];
  }

  /** Value following a CLI flag (buildClaudeArgs emits `--model X`, `--effort Y`). */
  const argAfter = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  it('passes the model override to the batch runner', async () => {
    const args = await runWith('CMODELBATCH', { modelOverride: 'override-model' });
    expect(argAfter(args, '--model')).toBe('override-model');
  });

  it('passes the model override to the streaming runner', async () => {
    const args = await runWith('CMODELSTREAM', { modelOverride: 'override-model' });
    expect(argAfter(args, '--model')).toBe('override-model');
  });

  it('falls back to the channel/default model without an override', async () => {
    const batchArgs = await runWith('CMODELBATCH');
    expect(argAfter(batchArgs, '--model')).toBe('channel-default-model');
    const streamArgs = await runWith('CMODELSTREAM');
    expect(argAfter(streamArgs, '--model')).toBe('channel-default-model');
  });

  it('passes the effort override to the batch runner', async () => {
    const args = await runWith('CMODELBATCH', { effortOverride: 'xhigh' });
    expect(argAfter(args, '--effort')).toBe('xhigh');
  });

  it('passes the effort override to the streaming runner', async () => {
    const args = await runWith('CMODELSTREAM', { effortOverride: 'xhigh' });
    expect(argAfter(args, '--effort')).toBe('xhigh');
  });

  it('falls back to the channel/default effort without an override', async () => {
    const batchArgs = await runWith('CMODELBATCH');
    expect(argAfter(batchArgs, '--effort')).toBe('medium');
    const streamArgs = await runWith('CMODELSTREAM');
    expect(argAfter(streamArgs, '--effort')).toBe('medium');
  });

  it('ignores an unknown effort override from a queue file (engine chokepoint guard)', async () => {
    const args = await runWith('CMODELBATCH', {
      effortOverride: 'bogus' as unknown as QueuedMessage['effortOverride'],
    });
    expect(argAfter(args, '--effort')).toBe('medium');
  });
});
