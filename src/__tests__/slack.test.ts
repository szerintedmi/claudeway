import { describe, it, expect, jest, beforeEach } from 'bun:test';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  FILE_THRESHOLD,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
} from '../adapters/slack/formatting.js';
import { isUserAllowed } from '../adapters/slack/utils.js';
import { formatDuration, formatTimeout, formatChannelConfig } from '../adapters/slack/commands.js';
import {
  getSnippetType,
  SlackChannelResponder,
  __resetAppendRateLimiterForTest,
} from '../adapters/slack/responder.js';
import type { WebClient } from '@slack/web-api';

describe('markdownToSlackMrkdwn', () => {
  describe('links', () => {
    it('converts [text](url) to <url|text>', () => {
      expect(markdownToSlackMrkdwn('[Claude](https://claude.ai)')).toBe(
        '<https://claude.ai|Claude>',
      );
    });

    it('handles multiple links in one string', () => {
      const input = '[A](https://a.com) and [B](https://b.com)';
      expect(markdownToSlackMrkdwn(input)).toBe('<https://a.com|A> and <https://b.com|B>');
    });

    it('leaves bare URLs unchanged', () => {
      expect(markdownToSlackMrkdwn('https://example.com')).toBe('https://example.com');
    });
  });

  describe('headings', () => {
    it('converts # heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('# Title')).toBe('*Title*');
    });

    it('converts ## heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('## Section')).toBe('*Section*');
    });

    it('converts ###### heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('###### Deep')).toBe('*Deep*');
    });

    it('does not convert # mid-sentence', () => {
      expect(markdownToSlackMrkdwn('color is #ff0000')).toBe('color is #ff0000');
    });
  });

  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToSlackMrkdwn('**bold text**')).toBe('*bold text*');
    });

    it('handles multiple bold spans', () => {
      expect(markdownToSlackMrkdwn('**a** and **b**')).toBe('*a* and *b*');
    });
  });

  describe('strikethrough', () => {
    it('converts ~~strike~~ to ~strike~', () => {
      expect(markdownToSlackMrkdwn('~~deleted~~')).toBe('~deleted~');
    });
  });

  describe('horizontal rules', () => {
    it('converts --- to ———', () => {
      expect(markdownToSlackMrkdwn('---')).toBe('———');
    });

    it('converts *** to ———', () => {
      expect(markdownToSlackMrkdwn('***')).toBe('———');
    });

    it('converts ___ to ———', () => {
      expect(markdownToSlackMrkdwn('___')).toBe('———');
    });
  });

  describe('code fences', () => {
    it('strips language tag from ```js code block', () => {
      expect(markdownToSlackMrkdwn('```js\ncode\n```')).toBe('```\ncode\n```');
    });

    it('strips language tag from ```typescript code block', () => {
      expect(markdownToSlackMrkdwn('```typescript\nconst x = 1;\n```')).toBe(
        '```\nconst x = 1;\n```',
      );
    });

    it('leaves ``` without language tag unchanged', () => {
      expect(markdownToSlackMrkdwn('```\ncode\n```')).toBe('```\ncode\n```');
    });
  });

  it('returns empty string unchanged', () => {
    expect(markdownToSlackMrkdwn('')).toBe('');
  });

  it('handles a realistic mixed-Markdown Claude response', () => {
    const input =
      '## Summary\n**key point** — see [docs](https://example.com)\n```js\nconsole.log(1)\n```';
    const expected =
      '*Summary*\n*key point* — see <https://example.com|docs>\n```\nconsole.log(1)\n```';
    expect(markdownToSlackMrkdwn(input)).toBe(expected);
  });

  describe('bullet points', () => {
    it('converts - item to • item', () => {
      expect(markdownToSlackMrkdwn('- first item')).toBe('• first item');
    });

    it('converts * item to • item', () => {
      expect(markdownToSlackMrkdwn('* first item')).toBe('• first item');
    });

    it('converts multiple bullet lines', () => {
      expect(markdownToSlackMrkdwn('- one\n- two\n- three')).toBe('• one\n• two\n• three');
    });

    it('does not convert bullets inside code blocks', () => {
      expect(markdownToSlackMrkdwn('```\n- not a bullet\n```')).toBe('```\n- not a bullet\n```');
    });

    it('does not convert - mid-word', () => {
      expect(markdownToSlackMrkdwn('well-known')).toBe('well-known');
    });
  });

  describe('HTML entity escaping', () => {
    it('escapes < in plain text', () => {
      expect(markdownToSlackMrkdwn('value < 0')).toBe('value &lt; 0');
    });

    it('escapes & in plain text', () => {
      expect(markdownToSlackMrkdwn('AT&T')).toBe('AT&amp;T');
    });

    it('does not escape < inside code blocks', () => {
      expect(markdownToSlackMrkdwn('```\nx < y\n```')).toBe('```\nx < y\n```');
    });

    it('does not escape & inside code blocks', () => {
      expect(markdownToSlackMrkdwn('```\na && b\n```')).toBe('```\na && b\n```');
    });

    it('still converts Markdown links after escaping (links create Slack tokens)', () => {
      expect(markdownToSlackMrkdwn('[visit](https://example.com)')).toBe(
        '<https://example.com|visit>',
      );
    });

    it('escapes bare < in text but not in converted link tokens', () => {
      expect(markdownToSlackMrkdwn('x < y and [visit](https://example.com)')).toBe(
        'x &lt; y and <https://example.com|visit>',
      );
    });
  });
});

describe('splitMessage', () => {
  const MAX = 3900;

  it('returns a single chunk for text under MAX_MESSAGE_LENGTH', () => {
    const text = 'hello world';
    expect(splitMessage(text)).toEqual([text]);
  });

  it('returns a single chunk for text exactly at MAX_MESSAGE_LENGTH', () => {
    const text = 'a'.repeat(MAX);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at the last newline before MAX_MESSAGE_LENGTH', () => {
    const firstPart = 'a'.repeat(MAX - 10) + '\n';
    const secondPart = 'b'.repeat(50);
    const chunks = splitMessage(firstPart + secondPart);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(firstPart.trimEnd());
    expect(chunks[1]).toBe(secondPart);
  });

  it('splits at MAX boundary when no newline found in first half', () => {
    const text = 'a'.repeat(MAX + 100);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(MAX);
  });

  it('trims leading whitespace from subsequent chunks', () => {
    const text = 'a'.repeat(MAX) + '\n   rest';
    const chunks = splitMessage(text);
    expect(chunks[1]).toBe('rest');
  });

  it('produces the correct number of chunks for 3x input', () => {
    const text = 'a'.repeat(MAX * 3);
    expect(splitMessage(text).length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatDuration', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it('formats sub-minute duration as "Xs"', () => {
    expect(formatDuration(ago(42_000))).toBe('42s');
  });

  it('formats exactly 60 seconds as "1m 0s"', () => {
    expect(formatDuration(ago(60_000))).toBe('1m 0s');
  });

  it('formats 90 seconds as "1m 30s"', () => {
    expect(formatDuration(ago(90_000))).toBe('1m 30s');
  });

  it('formats exactly 1 hour as "1h 0m 0s"', () => {
    expect(formatDuration(ago(3_600_000))).toBe('1h 0m 0s');
  });

  it('formats 1h 1m 1s correctly', () => {
    expect(formatDuration(ago(3_661_000))).toBe('1h 1m 1s');
  });

  it('formats 0 seconds as "0s"', () => {
    expect(formatDuration(ago(0))).toBe('0s');
  });
});

describe('formatTimeout', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatTimeout(45_000)).toBe('45s');
  });

  it('formats exactly 60s as "1m"', () => {
    expect(formatTimeout(60_000)).toBe('1m');
  });

  it('formats minutes without remaining seconds', () => {
    expect(formatTimeout(300_000)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatTimeout(3_660_000)).toBe('1h 1m');
  });

  it('formats exactly 1 hour', () => {
    expect(formatTimeout(3_600_000)).toBe('1h 0m');
  });
});

describe('formatChannelConfig', () => {
  it('formats a channel config with all fields', () => {
    const result = formatChannelConfig('C001', {
      folder: '/projects/test',
      model: 'opus',
      responseMode: 'stream-native',
      processMode: 'persistent',
      triggerMode: 'mention',
      timeoutMs: 300_000,
    });
    expect(result).toBe(
      [
        '<#C001>',
        '• Folder: `/projects/test`',
        '• Model: `opus`',
        '• Mode: `stream-native` / `persistent`',
        '• Trigger: `mention`',
        '• Timeout: 5m',
      ].join('\n'),
    );
  });

  it('formats a minimal channel config', () => {
    const result = formatChannelConfig('C999', {
      folder: '.',
      model: 'sonnet',
      responseMode: 'batch',
      processMode: 'oneshot',
      timeoutMs: 60_000,
    });
    expect(result).toContain('<#C999>');
    expect(result).toContain('`sonnet`');
    expect(result).toContain('`batch` / `oneshot`');
    expect(result).toContain('Trigger: `all`');
    expect(result).toContain('1m');
  });
});

describe('getSnippetType', () => {
  it('returns "markdown" for .md files', () => {
    expect(getSnippetType('response.md')).toBe('markdown');
  });

  it('returns "markdown" for .markdown files', () => {
    expect(getSnippetType('notes.markdown')).toBe('markdown');
  });

  it('returns "python" for .py files', () => {
    expect(getSnippetType('script.py')).toBe('python');
  });

  it('returns "javascript" for .js files', () => {
    expect(getSnippetType('app.js')).toBe('javascript');
  });

  it('returns "javascript" for .ts files', () => {
    expect(getSnippetType('index.ts')).toBe('javascript');
  });

  it('returns "text" for .txt files', () => {
    expect(getSnippetType('readme.txt')).toBe('text');
  });

  it('returns "json" for .json files', () => {
    expect(getSnippetType('config.json')).toBe('json');
  });

  it('returns "yaml" for .yml files', () => {
    expect(getSnippetType('config.yml')).toBe('yaml');
  });

  it('is case-insensitive', () => {
    expect(getSnippetType('README.MD')).toBe('markdown');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getSnippetType('image.png')).toBeUndefined();
  });

  it('returns undefined for files without extensions', () => {
    expect(getSnippetType('Makefile')).toBeUndefined();
  });
});

describe('isUserAllowed', () => {
  it('allows any user when allowedUsers is undefined', () => {
    expect(isUserAllowed(undefined, 'U123')).toBe(true);
  });

  it('allows any user when allowedUsers is empty', () => {
    expect(isUserAllowed([], 'U123')).toBe(true);
  });

  it('allows a user in the allowedUsers list', () => {
    expect(isUserAllowed(['U123', 'U456'], 'U123')).toBe(true);
  });

  it('denies a user not in the allowedUsers list', () => {
    expect(isUserAllowed(['U123', 'U456'], 'U789')).toBe(false);
  });

  it('denies unknown user when allowedUsers is set', () => {
    expect(isUserAllowed(['U123'], 'unknown')).toBe(false);
  });
});

describe('SlackChannelResponder.uploadFile payload', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createMockClient(): { client: WebClient; uploadCalls: any[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadCalls: any[] = [];
    const client = {
      files: {
        uploadV2: async (args: unknown) => {
          uploadCalls.push(args);
          return {};
        },
      },
      chat: { postMessage: async () => ({}) },
      reactions: { add: async () => ({}), remove: async () => ({}) },
    } as unknown as WebClient;
    return { client, uploadCalls };
  }

  it('passes snippet_type "markdown" for .md files', async () => {
    const { client, uploadCalls } = createMockClient();
    const responder = new SlackChannelResponder(client, 'C123', 'ts1', 'ts2', 'batch', 'U1');
    await responder.uploadFile('/tmp/output/response.md');

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).toEqual({
      channel_id: 'C123',
      thread_ts: 'ts1',
      file: '/tmp/output/response.md',
      filename: 'response.md',
      title: 'response.md',
      snippet_type: 'markdown',
    });
  });

  it('passes snippet_type "python" for .py files', async () => {
    const { client, uploadCalls } = createMockClient();
    const responder = new SlackChannelResponder(client, 'C123', 'ts1', 'ts2', 'batch', 'U1');
    await responder.uploadFile('/tmp/script.py');

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].snippet_type).toBe('python');
    expect(uploadCalls[0].filename).toBe('script.py');
  });

  it('omits snippet_type for binary files like .png', async () => {
    const { client, uploadCalls } = createMockClient();
    const responder = new SlackChannelResponder(client, 'C123', 'ts1', 'ts2', 'batch', 'U1');
    await responder.uploadFile('/tmp/image.png');

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).not.toHaveProperty('snippet_type');
    expect(uploadCalls[0].filename).toBe('image.png');
  });
});

describe('SlackChannelResponder native streaming fallback', () => {
  // Drain the responder's internal promise chains (thinking message → inner init →
  // append flush) without advancing timers — these settle on microtasks.
  async function microtasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  // The appendStream rate limiter is module-level state shared across streams;
  // reset it so token budget from one case can't starve the next.
  beforeEach(() => __resetAppendRateLimiterForTest());

  interface Send {
    kind: 'start' | 'append' | 'stop';
    text?: string;
  }

  interface Calls {
    posts: Record<string, unknown>[];
    updates: Record<string, unknown>[];
    deletes: Record<string, unknown>[];
    uploads: Record<string, unknown>[];
    sends: Send[];
    sequence: string[];
  }

  interface MockSpec {
    /** start/append calls at this 1-based index and later throw a terminal error. */
    failFrom?: number;
    /** The start/append call at this 1-based index throws one transient error. */
    transientAt?: number;
    /** stopStream throws a terminal error. */
    failStop?: boolean;
    /** uploadV2 rejects. */
    failUpload?: boolean;
  }

  const TERMINAL = { data: { error: 'message_not_in_streaming_state' } };
  const TRANSIENT = { data: { error: 'ratelimited' } };

  // Models the direct startStream/appendStream/stopStream API the responder now
  // drives — there is no hidden SDK buffer, so `sends` is the exact wire history.
  function createMockClient(spec: MockSpec = {}): { client: WebClient; calls: Calls } {
    const calls: Calls = {
      posts: [],
      updates: [],
      deletes: [],
      uploads: [],
      sends: [],
      sequence: [],
    };
    let n = 0; // counts startStream + appendStream calls
    const maybeThrow = (): void => {
      if (spec.transientAt === n) throw TRANSIENT;
      if (spec.failFrom != null && n >= spec.failFrom) throw TERMINAL;
    };
    const client = {
      chat: {
        postMessage: async (a: Record<string, unknown>) => {
          calls.posts.push(a);
          return { ts: `posted-${calls.posts.length}` };
        },
        update: async (a: Record<string, unknown>) => {
          calls.updates.push(a);
          calls.sequence.push('update');
          return {};
        },
        delete: async (a: Record<string, unknown>) => {
          calls.deletes.push(a);
          calls.sequence.push(`delete:${a.ts}`);
          return {};
        },
        startStream: async (a: Record<string, unknown>) => {
          n += 1;
          calls.sends.push({ kind: 'start', text: a.markdown_text as string });
          calls.sequence.push('start');
          maybeThrow();
          return { ts: 'stream-ts' };
        },
        appendStream: async (a: Record<string, unknown>) => {
          n += 1;
          calls.sends.push({ kind: 'append', text: a.markdown_text as string });
          calls.sequence.push('append');
          maybeThrow();
          return {};
        },
        stopStream: async (a: Record<string, unknown>) => {
          calls.sends.push({ kind: 'stop', text: a.markdown_text as string | undefined });
          calls.sequence.push('stop');
          if (spec.failStop) throw TERMINAL;
          return { ts: 'stream-ts' };
        },
      },
      reactions: { add: async () => ({}), remove: async () => ({}) },
      files: {
        uploadV2: async (a: Record<string, unknown>) => {
          calls.uploads.push(a);
          calls.sequence.push('upload');
          if (spec.failUpload) throw new Error('upload failed');
          return {};
        },
      },
    } as unknown as WebClient;
    return { client, calls };
  }

  const appendsOf = (calls: Calls): Send[] => calls.sends.filter((s) => s.kind === 'append');
  const stopsOf = (calls: Calls): Send[] => calls.sends.filter((s) => s.kind === 'stop');

  function makeResponder(client: WebClient): SlackChannelResponder {
    return new SlackChannelResponder(
      client,
      'C123',
      'thread-ts',
      'msg-ts',
      'stream-native',
      'U1',
      'T1',
    );
  }

  it('repairs the partial message with the full text when the stream finalizes early', async () => {
    const { client, calls } = createMockClient({ failFrom: 2 });
    const responder = makeResponder(client);
    jest.useFakeTimers();
    try {
      const sr = responder.createStreamingResponder();

      sr.onTextDelta('Hello '); // first flush (startStream) succeeds, captures ts
      await microtasks();
      sr.onTextDelta('world'); // batched into pending
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS); // timer flushes it
      await microtasks(); // appendStream rejects (terminal) → stream marked broken mid-flight
      await sr.finish();
      await responder.onStreamComplete('Hello world', sr);

      // The finalized message is overwritten in place with the complete text — no duplicate bubble.
      expect(calls.updates).toHaveLength(1);
      expect(calls.updates[0].ts).toBe('stream-ts');
      expect(calls.updates[0].text).toBe('Hello world');
      // No file upload for a small response.
      expect(calls.uploads).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-deliver when the native stream completes cleanly', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Hello ');
    await microtasks();
    sr.onTextDelta('world');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Hello world', sr);

    // Clean finish → native display already showed everything; no repair update/post/upload.
    expect(calls.updates).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
    // Only the initial thinking message was posted (later deleted when the stream started).
    expect(calls.posts).toHaveLength(1);
    expect(stopsOf(calls)).toHaveLength(1);
    // The tail that arrived after the first flush rode along on stopStream.
    expect(stopsOf(calls)[0].text).toBe('world');
  });

  it('deletes a tool-status message posted mid-stream on a clean finish', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Looking into it'); // startStream → thinking message (posted-1) deleted
    await microtasks();
    sr.onToolEvent({ phase: 'start', toolName: 'Bash' }); // posts a new status message (posted-2)
    await microtasks();
    sr.onTextDelta(' — done'); // more text appended to the stream
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Looking into it — done', sr);

    // The mid-stream tool-status message must be cleaned up even though the
    // stream finished cleanly (streamTs set, not broken).
    const toolStatusTs = (calls.posts[1] as { ts?: string } | undefined)?.ts ?? 'posted-2';
    expect(calls.deletes.some((d) => d.ts === toolStatusTs)).toBe(true);
    // Sanity: a tool-status message was actually posted (thinking + tool status).
    expect(calls.posts).toHaveLength(2);
  });

  it('retries a transient append exactly once, without doubling the text', async () => {
    // transientAt: 2 → the first appendStream (call #2 after startStream) fails once.
    const { client, calls } = createMockClient({ transientAt: 2 });
    const responder = makeResponder(client);
    jest.useFakeTimers();
    try {
      const sr = responder.createStreamingResponder();

      sr.onTextDelta('Hello '); // startStream ok
      await microtasks();
      sr.onTextDelta('world'); // pending
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // appendStream('world') throws transient → pending kept, NOT broken
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // appendStream('world') retried successfully
      await sr.finish();
      await responder.onStreamComplete('Hello world', sr);

      // Stream survived the transient error: no fallback delivery.
      expect(calls.updates).toHaveLength(0);
      expect(calls.uploads).toHaveLength(0);
      // Each appendStream carried 'world' exactly once — never the doubled
      // 'worldworld' that a second buffer would have produced.
      const appends = appendsOf(calls);
      expect(appends).toHaveLength(2);
      expect(appends.every((a) => a.text === 'world')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uploads a file BEFORE dropping the partial message for a huge early-finalized response', async () => {
    const { client, calls } = createMockClient({ failStop: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const huge = 'x'.repeat(FILE_THRESHOLD + 1);

    sr.onTextDelta('partial ');
    await microtasks();
    sr.onTextDelta('more');
    await microtasks();
    await sr.finish(); // stopStream fails → broken
    await responder.onStreamComplete(huge, sr);

    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0].content).toBe(huge);
    expect(calls.uploads[0].snippet_type).toBe('markdown');
    // The partial message is dropped only AFTER a successful upload.
    expect(calls.deletes.some((d) => d.ts === 'stream-ts')).toBe(true);
    expect(calls.sequence.indexOf('upload')).toBeLessThan(
      calls.sequence.indexOf('delete:stream-ts'),
    );
  });

  it('keeps the partial message if the huge-response upload fails', async () => {
    const { client, calls } = createMockClient({ failStop: true, failUpload: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const huge = 'x'.repeat(FILE_THRESHOLD + 1);

    sr.onTextDelta('partial ');
    await microtasks();
    await sr.finish();
    await expect(responder.onStreamComplete(huge, sr)).rejects.toThrow();

    // Upload was attempted but failed — the partial streamed message must NOT be dropped.
    expect(calls.uploads).toHaveLength(1);
    expect(calls.deletes.some((d) => d.ts === 'stream-ts')).toBe(false);
  });

  it('sends an invisible keepalive append during an idle gap', async () => {
    jest.useFakeTimers();
    try {
      const { client, calls } = createMockClient();
      const responder = makeResponder(client);
      const sr = responder.createStreamingResponder();

      sr.onTextDelta('Working on it');
      await microtasks(); // inner init + first append (resets the idle clock)

      // No further text — advance past the keepalive window so an idle tick fires.
      jest.advanceTimersByTime(STREAM_NATIVE_KEEPALIVE_MS + STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // queued keepalive flush runs

      expect(appendsOf(calls).some((a) => a.text === STREAM_KEEPALIVE_TOKEN)).toBe(true);
      // The keepalive token is zero-width — it must not be visible content.
      expect(STREAM_KEEPALIVE_TOKEN).toBe('\u200b');

      await sr.finish(); // clears the flush interval
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SlackChannelResponder.sendResponse file upload payload', () => {
  it('passes snippet_type "markdown" for oversized responses', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadCalls: any[] = [];
    const client = {
      files: {
        uploadV2: async (args: unknown) => {
          uploadCalls.push(args);
          return {};
        },
      },
      chat: { postMessage: async () => ({}) },
      reactions: { add: async () => ({}), remove: async () => ({}) },
    } as unknown as WebClient;

    const responder = new SlackChannelResponder(client, 'C123', 'ts1', 'ts2', 'batch', 'U1');
    const longText = 'x'.repeat(FILE_THRESHOLD + 1);
    await responder.sendResponse(longText);

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].content).toBe(longText);
    expect(uploadCalls[0].filename).toBe('response.md');
    expect(uploadCalls[0].snippet_type).toBe('markdown');
  });
});
