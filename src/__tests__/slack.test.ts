import { describe, it, expect, jest, beforeEach } from 'bun:test';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  splitDetails,
  FILE_THRESHOLD,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  formatToolTaskTitle,
} from '../adapters/slack/formatting.js';
import { formatDuration, formatTimeout, formatChannelConfig } from '../adapters/slack/commands.js';
import { getSnippetType, SlackChannelResponder } from '../adapters/slack/responder.js';
import { __resetAppendRateLimiterForTest } from '../adapters/slack/stream.js';
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

    it('preserves Slack-native link tokens the model emits directly', () => {
      // Claude is told (system prompt) to output <URL|label> for links. The
      // converter must leave these intact, not escape the leading <.
      expect(
        markdownToSlackMrkdwn('<https://hostaway.atlassian.net/browse/AI-647|AI-647> — done'),
      ).toBe('<https://hostaway.atlassian.net/browse/AI-647|AI-647> — done');
    });

    it('preserves bare angle-bracket links', () => {
      expect(markdownToSlackMrkdwn('see <https://example.com>')).toBe('see <https://example.com>');
    });

    it('preserves mailto/tel link tokens', () => {
      expect(markdownToSlackMrkdwn('<mailto:a@b.com|email> or <tel:+1234|call>')).toBe(
        '<mailto:a@b.com|email> or <tel:+1234|call>',
      );
    });

    it('preserves user, channel, and special mention tokens', () => {
      expect(markdownToSlackMrkdwn('cc <@U123ABC> in <#C456DEF|general> <!here>')).toBe(
        'cc <@U123ABC> in <#C456DEF|general> <!here>',
      );
    });

    it('still escapes < that does not open a Slack token', () => {
      expect(markdownToSlackMrkdwn('a<b and <3 and <not-a-token>')).toBe(
        'a&lt;b and &lt;3 and &lt;not-a-token>',
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

describe('splitDetails', () => {
  it('returns the whole text as body when no marker is present', () => {
    expect(splitDetails('just an answer')).toEqual({ body: 'just an answer', details: null });
  });

  it('splits TL;DR and details on the marker, dropping the marker line', () => {
    const { body, details } = splitDetails('TL;DR answer\n---DETAILS---\nthe long version');
    expect(body).toBe('TL;DR answer');
    expect(details).toBe('the long version');
  });

  it('tolerates surrounding whitespace, extra dashes, and case', () => {
    const { body, details } = splitDetails('short\n  ----- details ----  \nmore');
    expect(body).toBe('short');
    expect(details).toBe('more');
  });

  it('splits only on the first marker, keeping later markers in details', () => {
    const { body, details } = splitDetails('a\n---DETAILS---\nb\n---DETAILS---\nc');
    expect(body).toBe('a');
    expect(details).toBe('b\n---DETAILS---\nc');
  });

  it('does not fold when nothing follows the marker', () => {
    expect(splitDetails('answer\n---DETAILS---\n   ')).toEqual({
      body: 'answer',
      details: null,
    });
  });

  it('promotes post-marker content to body when nothing precedes the marker', () => {
    expect(splitDetails('---DETAILS---\nonly details')).toEqual({
      body: 'only details',
      details: null,
    });
  });

  it('does not treat a plain horizontal rule as a marker', () => {
    expect(splitDetails('above\n---\nbelow')).toEqual({
      body: 'above\n---\nbelow',
      details: null,
    });
  });

  it('ignores a marker inside a fenced code block', () => {
    const text = 'answer\n```\n--DETAILS--\ncode content\n```\ntail';
    expect(splitDetails(text)).toEqual({ body: text, details: null });
  });

  it('splits on a real marker that follows a fence containing a decoy', () => {
    const { body, details } = splitDetails(
      'answer\n```md\n--DETAILS--\n```\n--DETAILS--\nreal details',
    );
    expect(body).toBe('answer\n```md\n--DETAILS--\n```');
    expect(details).toBe('real details');
  });
});

describe('formatToolTaskTitle', () => {
  it('uses the display verb with the key arg', () => {
    expect(formatToolTaskTitle('Read', 'src/foo.ts')).toBe('Reading src/foo.ts');
    expect(formatToolTaskTitle('Bash', null)).toBe('Running');
  });

  it('prettifies MCP tool ids as tool (server)', () => {
    expect(formatToolTaskTitle('mcp__mcp-atlassian__jira_search', 'project = AI')).toBe(
      'Using jira_search (mcp-atlassian) project = AI',
    );
  });

  it('trims oversized key args to keep the title a one-liner', () => {
    const title = formatToolTaskTitle('Bash', 'x'.repeat(500));
    expect(title.length).toBeLessThanOrEqual(110);
    expect(title.endsWith('…')).toBe(true);
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
        '• Collapse work log: `true`',
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

describe('SlackChannelResponder native streaming (Thinking Steps)', () => {
  // Drain the responder's internal promise chains (stream open → append flush)
  // without advancing timers — these settle on microtasks.
  async function microtasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  // The appendStream rate limiter is module-level state shared across streams;
  // reset it so token budget from one case can't starve the next.
  beforeEach(() => __resetAppendRateLimiterForTest());

  interface Chunk {
    type: string;
    id?: string;
    title?: string;
    status?: string;
    details?: string;
    output?: string;
    text?: string;
  }

  interface Send {
    kind: 'start' | 'append' | 'stop';
    chunks?: Chunk[];
    blocks?: Record<string, unknown>[];
    ts?: string;
  }

  interface Calls {
    posts: Record<string, unknown>[];
    updates: Record<string, unknown>[];
    deletes: Record<string, unknown>[];
    uploads: Record<string, unknown>[];
    reactions: { action: 'add' | 'remove'; name: string; ts: string }[];
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
    /** stopStream throws invalid_blocks whenever final blocks are attached. */
    rejectStopBlocks?: boolean;
    /** stopStream throws one transient error, then succeeds. */
    stopTransientOnce?: boolean;
    /** uploadV2 rejects. */
    failUpload?: boolean;
  }

  const TERMINAL = { data: { error: 'message_not_in_streaming_state' } };
  const TRANSIENT = { data: { error: 'ratelimited' } };
  const INVALID_BLOCKS = { data: { error: 'invalid_blocks' } };

  // Models the chunk-based startStream/appendStream/stopStream API the
  // responder drives — `sends` is the exact wire history (a send that threw is
  // still recorded, matching a request that failed after being issued).
  function createMockClient(spec: MockSpec = {}): { client: WebClient; calls: Calls } {
    const calls: Calls = {
      posts: [],
      updates: [],
      deletes: [],
      uploads: [],
      reactions: [],
      sends: [],
      sequence: [],
    };
    let n = 0; // counts startStream + appendStream calls
    let stopTransientUsed = false;
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
          calls.sends.push({ kind: 'start', chunks: a.chunks as Chunk[], ts: 'stream-ts' });
          calls.sequence.push('start');
          maybeThrow();
          return { ts: 'stream-ts' };
        },
        appendStream: async (a: Record<string, unknown>) => {
          n += 1;
          calls.sends.push({ kind: 'append', chunks: a.chunks as Chunk[], ts: a.ts as string });
          calls.sequence.push('append');
          maybeThrow();
          return {};
        },
        stopStream: async (a: Record<string, unknown>) => {
          calls.sends.push({
            kind: 'stop',
            chunks: a.chunks as Chunk[] | undefined,
            blocks: a.blocks as Record<string, unknown>[] | undefined,
            ts: a.ts as string,
          });
          calls.sequence.push('stop');
          if (spec.failStop) throw TERMINAL;
          if (spec.rejectStopBlocks && a.blocks) throw INVALID_BLOCKS;
          if (spec.stopTransientOnce && !stopTransientUsed) {
            stopTransientUsed = true;
            throw TRANSIENT;
          }
          return { ts: 'stream-ts' };
        },
      },
      reactions: {
        add: async (a: Record<string, unknown>) => {
          calls.reactions.push({
            action: 'add',
            name: a.name as string,
            ts: a.timestamp as string,
          });
          return {};
        },
        remove: async (a: Record<string, unknown>) => {
          calls.reactions.push({
            action: 'remove',
            name: a.name as string,
            ts: a.timestamp as string,
          });
          return {};
        },
      },
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
  /** Every chunk that hit the wire, in order (including sends that then failed). */
  const wireChunks = (calls: Calls): Chunk[] => calls.sends.flatMap((s) => s.chunks ?? []);
  const wireTasks = (calls: Calls): Chunk[] =>
    wireChunks(calls).filter((c) => c.type === 'task_update');
  /** Concatenated markdown that hit the wire. Only meaningful without failures. */
  const wireMarkdown = (calls: Calls): string =>
    wireChunks(calls)
      .filter((c) => c.type === 'markdown_text')
      .map((c) => c.text ?? '')
      .join('');

  function makeResponder(client: WebClient, collapseWorkingNotes = true): SlackChannelResponder {
    return new SlackChannelResponder(
      client,
      'C123',
      'thread-ts',
      'msg-ts',
      'stream-native',
      'U1',
      'T1',
      collapseWorkingNotes,
    );
  }

  it('opens the stream eagerly with a Thinking card (instant feedback, no placeholder post)', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    responder.createStreamingResponder();
    await microtasks();

    expect(calls.posts).toHaveLength(0); // no placeholder message
    const start = calls.sends.find((s) => s.kind === 'start');
    // Plan-box title first, then the seed Thinking card — one grouped box.
    expect(start?.chunks?.[0]).toMatchObject({ type: 'plan_update', title: 'Work log' });
    expect(start?.chunks?.[1]).toMatchObject({
      type: 'task_update',
      title: 'Thinking',
      status: 'in_progress',
    });
  });

  it('does not re-deliver when the stream completes cleanly', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Hello ');
    await microtasks();
    sr.onTextDelta('world');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Hello world', sr);

    // Clean finish → the stream already showed everything; no repair or upload.
    expect(calls.updates).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
    expect(calls.posts).toHaveLength(0);
    expect(stopsOf(calls)).toHaveLength(1);
    // The text (batched, unflushed) rode along on stopStream; the Thinking seed
    // card was completed at the text boundary.
    expect(wireMarkdown(calls)).toBe('Hello world');
    const thinking = wireTasks(calls).filter((c) => c.title === 'Thinking');
    expect(thinking[thinking.length - 1]?.status).toBe('complete');
  });

  it('rebuilds the message with work-log blocks when the stream finalizes early', async () => {
    const { client, calls } = createMockClient({ failFrom: 2 });
    const responder = makeResponder(client);
    jest.useFakeTimers();
    try {
      const sr = responder.createStreamingResponder();

      sr.onTextDelta('Hello '); // first flush (startStream) succeeded, captured ts
      await microtasks();
      sr.onTextDelta('world'); // batched into pending
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // appendStream rejects (terminal) → stream broken
      await sr.finish();
      await responder.onStreamComplete('Hello world', sr);

      // The finalized message is rebuilt in place: plan block (work log) on top,
      // the full answer as section blocks. No duplicate bubble, no upload.
      expect(calls.updates).toHaveLength(1);
      expect(calls.updates[0].ts).toBe('stream-ts');
      const blocks = calls.updates[0].blocks as Record<string, unknown>[];
      expect(blocks[0].type).toBe('plan');
      expect(blocks.some((b) => b.type === 'section')).toBe(true);
      expect(JSON.stringify(blocks)).toContain('Hello world');
      expect(calls.uploads).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps tool start/complete to one task card updated in place (same id)', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    jest.useFakeTimers();
    try {
      const sr = responder.createStreamingResponder();
      await microtasks();

      sr.onToolEvent({ phase: 'start', toolName: 'Bash' });
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // in_progress card flushed
      sr.onToolEvent({ phase: 'complete', toolName: 'Bash', keyArg: 'ls -la' });
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // complete card flushed
      await sr.finish();
      await responder.onStreamComplete('', sr);

      const bashCards = wireTasks(calls).filter((c) => c.title?.startsWith('Running'));
      expect(bashCards.length).toBeGreaterThanOrEqual(2);
      const ids = new Set(bashCards.map((c) => c.id));
      expect(ids.size).toBe(1); // same card updated, not a new one
      expect(bashCards[0].status).toBe('in_progress');
      expect(bashCards[bashCards.length - 1]).toMatchObject({
        title: 'Running ls -la',
        status: 'complete',
      });
      // Empty answer: the message stays (it holds the work log) — no delete.
      expect(calls.deletes).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rolls reasoning into the Thinking card and completes it at the text boundary', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    const reasoning = 'I should check the config first because '.repeat(12); // ~480 chars
    sr.onReasoningDelta?.(reasoning);
    await microtasks();
    sr.onTextDelta('Answer.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Answer.', sr);

    const thinking = wireTasks(calls).filter((c) => c.title === 'Thinking');
    const last = thinking[thinking.length - 1];
    expect(last?.status).toBe('complete');
    // Rolling tail: truncated to the field cap, ellipsis-prefixed.
    expect(last?.details?.length).toBeLessThanOrEqual(256);
    expect(last?.details?.startsWith('…')).toBe(true);
    expect(last?.details).toContain('config first');
  });

  it('suppresses reasoning details when collapseWorkingNotes is false', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client, false);
    const sr = responder.createStreamingResponder();

    sr.onReasoningDelta?.('secret internal thoughts');
    await microtasks();
    sr.onTextDelta('Answer.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Answer.', sr);

    expect(JSON.stringify(calls.sends)).not.toContain('secret internal thoughts');
  });

  it('keeps narration in the body and does not rebuild when the final run matches result', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Let me check the files first. '); // narration — a tool follows
    await microtasks();
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'a.ts' });
    await microtasks();
    sr.onTextDelta('The answer is 42.'); // the real answer (nothing follows)
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('The answer is 42.', sr);

    // Narration streamed live in place, interleaved with the tool card — and it
    // stays there. The live message is NOT rewritten (result matches the final run).
    expect(wireMarkdown(calls)).toBe('Let me check the files first. The answer is 42.');
    expect(wireTasks(calls).some((c) => c.title === 'Reading a.ts')).toBe(true);
    expect(calls.updates).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
  });

  it('rebuilds from result when a late tool event followed the real answer', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('The answer is 42.');
    await microtasks();
    // A trailing tool/subagent event makes the final run empty — live answer unreliable.
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'z.ts' });
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('The answer is 42.', sr);

    expect(calls.updates).toHaveLength(1);
    const blocks = calls.updates[0].blocks as Record<string, unknown>[];
    expect(blocks[0].type).toBe('plan');
    expect(JSON.stringify(blocks)).toContain('The answer is 42.');
  });

  it('does NOT rebuild for the missing-result fallback (streamed body stands)', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('partial narration ');
    await microtasks();
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'k.ts' }); // clears the run
    await microtasks();
    await sr.finish();
    // Engine fallback: result.response was empty → finalText = getFullText().
    await responder.onStreamComplete(sr.getFullText(), sr, { authoritative: false });

    expect(calls.updates).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
  });

  it('withholds the details marker from the wire and delivers a container at stop', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const full = 'TL;DR answer\n---DETAILS---\nthe long version';

    sr.onTextDelta('TL;DR answer');
    await microtasks();
    sr.onTextDelta('\n---DETAILS---\nthe long version');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete(full, sr);

    // Neither the marker nor the details content ever hit the streamed text.
    expect(wireMarkdown(calls)).not.toContain('DETAILS');
    expect(wireMarkdown(calls)).not.toContain('the long version');
    // The details container rode along on stopStream — collapsed inside the message.
    const stop = stopsOf(calls)[0];
    expect(stop.blocks?.[0]).toMatchObject({ type: 'container' });
    expect(JSON.stringify(stop.blocks)).toContain('the long version');
    // No rebuild, no separate details message.
    expect(calls.updates).toHaveLength(0);
    expect(calls.posts).toHaveLength(0);
  });

  it('streams a marker inside a code fence untouched (no fold)', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const full = 'Use this separator:\n```\n--DETAILS--\n```\nafter fence';

    sr.onTextDelta(full);
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete(full, sr);

    expect(wireMarkdown(calls)).toContain('--DETAILS--');
    expect(stopsOf(calls)[0].blocks).toBeUndefined();
    expect(calls.posts).toHaveLength(0);
  });

  it('falls back to a separate details message when the container is rejected at stop', async () => {
    const { client, calls } = createMockClient({ rejectStopBlocks: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const full = 'TL;DR\n--DETAILS--\nhidden stuff';

    sr.onTextDelta(full);
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete(full, sr);

    // stopStream was retried without blocks so the stream still finalized.
    const stops = stopsOf(calls);
    expect(stops.length).toBe(2);
    expect(stops[1].blocks).toBeUndefined();
    // The details were then delivered as their own container message.
    expect(calls.posts).toHaveLength(1);
    expect(JSON.stringify(calls.posts[0].blocks)).toContain('hidden stuff');
  });

  it('flips open cards to error and still stops the stream on a failed turn', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onToolEvent({ phase: 'start', toolName: 'Bash' });
    await microtasks();
    await sr.finish({ ok: false, errorMessage: 'process exited with code 1' });

    const stop = stopsOf(calls)[0];
    expect(stop).toBeDefined();
    const closing = (stop.chunks ?? []).filter((c) => c.type === 'task_update');
    // The open Bash card ends as error, and a synthetic Error card carries the message.
    expect(closing.some((c) => c.title?.startsWith('Running') && c.status === 'error')).toBe(true);
    const errCard = closing.find((c) => c.title === 'Error');
    expect(errCard?.details).toContain('process exited with code 1');
  });

  it('retries a transient append without losing or doubling text', async () => {
    // transientAt: 2 → the first appendStream (call #2 after startStream) fails once.
    const { client, calls } = createMockClient({ transientAt: 2 });
    const responder = makeResponder(client);
    jest.useFakeTimers();
    try {
      const sr = responder.createStreamingResponder();

      sr.onTextDelta('Hello '); // startStream ok (carries seed; text pending)
      await microtasks();
      sr.onTextDelta('world');
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // append throws transient → batch restored, NOT broken
      jest.advanceTimersByTime(STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // retried successfully
      await sr.finish();
      await responder.onStreamComplete('Hello world', sr);

      // Stream survived: no fallback delivery.
      expect(calls.updates).toHaveLength(0);
      expect(calls.uploads).toHaveLength(0);
      // The failed and retried appends carried identical content — never doubled.
      const appends = appendsOf(calls);
      expect(appends).toHaveLength(2);
      const texts = appends.map((a) =>
        (a.chunks ?? [])
          .filter((c) => c.type === 'markdown_text')
          .map((c) => c.text)
          .join(''),
      );
      expect(texts[0]).toBe(texts[1]);
      expect(texts[0]).toContain('world');
      expect(texts[0]).not.toContain('worldworld');
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a transient stopStream failure', async () => {
    const { client, calls } = createMockClient({ stopTransientOnce: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Hello');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Hello', sr);

    // First stop threw a transient error; the retry succeeded → no rebuild needed.
    expect(stopsOf(calls)).toHaveLength(2);
    expect(calls.updates).toHaveLength(0);
  }, 10_000);

  it('uploads a huge response as a file and keeps the card-bearing message', async () => {
    const { client, calls } = createMockClient({ failStop: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const huge = 'x'.repeat(FILE_THRESHOLD + 1);

    sr.onTextDelta('partial ');
    await microtasks();
    await sr.finish(); // stopStream fails terminally → broken
    await responder.onStreamComplete(huge, sr);

    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0].content).toBe(huge);
    expect(calls.uploads[0].snippet_type).toBe('markdown');
    // The streamed message holds the work-log cards — it is updated to point at
    // the file, never deleted, and only after a successful upload.
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toHaveLength(1);
    expect(calls.sequence.indexOf('upload')).toBeLessThan(calls.sequence.indexOf('update'));
  });

  it('keeps the partial message untouched if the huge-response upload fails', async () => {
    const { client, calls } = createMockClient({ failStop: true, failUpload: true });
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    const huge = 'x'.repeat(FILE_THRESHOLD + 1);

    sr.onTextDelta('partial ');
    await microtasks();
    await sr.finish();
    await expect(responder.onStreamComplete(huge, sr)).rejects.toThrow();

    // Upload attempted (with retries) but failed — nothing rewritten or dropped.
    expect(calls.uploads.length).toBeGreaterThanOrEqual(1);
    expect(calls.updates).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  }, 10_000);

  it('re-sends the last task card as an invisible keepalive during idle gaps', async () => {
    jest.useFakeTimers();
    try {
      const { client, calls } = createMockClient();
      const responder = makeResponder(client);
      const sr = responder.createStreamingResponder();
      await microtasks(); // seed card flushed (startStream)

      jest.advanceTimersByTime(STREAM_NATIVE_KEEPALIVE_MS + STREAM_NATIVE_FLUSH_INTERVAL_MS);
      await microtasks(); // idle tick → keepalive flush

      const keepalives = appendsOf(calls);
      expect(keepalives.length).toBeGreaterThanOrEqual(1);
      // The keepalive is an idempotent re-send of the last task_update — invisible.
      expect(keepalives[0].chunks?.[0]).toMatchObject({
        type: 'task_update',
        title: 'Thinking',
      });

      await sr.finish();
    } finally {
      jest.useRealTimers();
    }
  });

  it('adds the streaming reaction when the stream opens and removes it on finish', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    await microtasks();

    const added = calls.reactions.filter((r) => r.action === 'add' && r.name === 'partyparrot');
    expect(added).toHaveLength(1);
    expect(added[0].ts).toBe('stream-ts');

    await sr.finish();
    const removed = calls.reactions.filter(
      (r) => r.action === 'remove' && r.name === 'partyparrot',
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].ts).toBe('stream-ts');
  });

  it('waits for the reaction add to land before removing it on a fast finish', async () => {
    const { client, calls } = createMockClient();
    // Gate the reaction add so it stays in-flight while finish() runs — this is the
    // race: a void add + an awaited remove could otherwise remove-then-add and
    // leave the parrot stuck on the finished message.
    const reactions = client.reactions as unknown as {
      add: (a: Record<string, unknown>) => Promise<unknown>;
      remove: (a: Record<string, unknown>) => Promise<unknown>;
    };
    const origAdd = reactions.add;
    let releaseAdd!: () => void;
    const gate = new Promise<void>((r) => (releaseAdd = r));
    reactions.add = async (a) => {
      await gate;
      return origAdd(a);
    };

    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();
    await microtasks(); // stream opened → add fired (gated, in-flight)

    const finishP = sr.finish();
    await microtasks();
    // The add is still gated, so finish() must NOT have removed yet.
    expect(calls.reactions.some((r) => r.action === 'remove')).toBe(false);

    releaseAdd();
    await finishP;
    // Order is add-then-remove; the reaction never ends up stuck.
    expect(calls.reactions.map((r) => r.action)).toEqual(['add', 'remove']);
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
