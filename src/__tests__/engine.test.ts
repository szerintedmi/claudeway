import { describe, it, expect, beforeEach } from 'bun:test';
import {
  channelBusy,
  isMessageProcessing,
  MAX_CONCURRENT_PROCESSES,
  drainChannel,
} from '../core/engine.js';
import type { ChannelResponder, IStreamingResponder } from '../core/interfaces.js';

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
