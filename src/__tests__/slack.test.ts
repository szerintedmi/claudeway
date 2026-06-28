import { describe, it, expect, jest, beforeEach } from 'bun:test';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  splitDetails,
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
      reactions: [],
      sends: [],
      sequence: [],
    };
    let n = 0; // counts startStream + appendStream calls
    let startN = 0; // counts startStream calls (one per distinct stream)
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
          startN += 1;
          // Distinct ts per stream so two-stream cases (notes + answer) are
          // distinguishable. The first stream keeps the legacy 'stream-ts' id.
          const ts = startN === 1 ? 'stream-ts' : `stream-ts-${startN}`;
          calls.sends.push({ kind: 'start', text: a.markdown_text as string, ts });
          calls.sequence.push('start');
          maybeThrow();
          return { ts };
        },
        appendStream: async (a: Record<string, unknown>) => {
          n += 1;
          calls.sends.push({ kind: 'append', text: a.markdown_text as string, ts: a.ts as string });
          calls.sequence.push('append');
          maybeThrow();
          return {};
        },
        stopStream: async (a: Record<string, unknown>) => {
          calls.sends.push({
            kind: 'stop',
            text: a.markdown_text as string | undefined,
            ts: a.ts as string,
          });
          calls.sequence.push('stop');
          if (spec.failStop) throw TERMINAL;
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

  // Default helper keeps collapse OFF so these tests exercise raw stream mechanics
  // (no working-notes prefix or final collapse). Collapse behavior has its own tests.
  function makeResponder(client: WebClient): SlackChannelResponder {
    return new SlackChannelResponder(
      client,
      'C123',
      'thread-ts',
      'msg-ts',
      'stream-native',
      'U1',
      'T1',
      false, // collapseWorkingNotes
    );
  }

  function makeCollapsingResponder(client: WebClient): SlackChannelResponder {
    return new SlackChannelResponder(
      client,
      'C123',
      'thread-ts',
      'msg-ts',
      'stream-native',
      'U1',
      'T1',
      true, // collapseWorkingNotes
    );
  }

  // The working-notes attachment text. Notes collapse via an in-place chat.update
  // (with attachments), so look there rather than at posts.
  function notesAttachmentText(calls: Calls): string | undefined {
    const upd = calls.updates.find((p) => Array.isArray(p.attachments));
    if (!upd) return undefined;
    return (upd.attachments as Array<{ text?: string }>)[0]?.text;
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

  it('puts the streaming reaction on the work-log stream and removes it on finish', async () => {
    const { client, calls } = createMockClient();
    const responder = makeCollapsingResponder(client);
    const sr = responder.createStreamingResponder();

    // Reasoning opens the work-log stream first (ts 'stream-ts'); the answer
    // stream opens later (ts 'stream-ts-2'). The reaction must land on the
    // work-log stream — the message live for the whole turn.
    sr.onReasoningDelta?.('thinking…');
    await microtasks();
    sr.onTextDelta('the answer');
    await microtasks();

    const added = calls.reactions.filter((r) => r.action === 'add' && r.name === 'partyparrot');
    expect(added).toHaveLength(1);
    expect(added[0].ts).toBe('stream-ts'); // the work-log message, not the answer

    await sr.finish();
    await responder.onStreamComplete('the answer', sr);

    const removed = calls.reactions.filter(
      (r) => r.action === 'remove' && r.name === 'partyparrot',
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].ts).toBe('stream-ts');
  });

  it('falls back to the answer stream for the reaction when there is no work log', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client); // collapse off → no work-log stream
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Hello ');
    await microtasks();
    await sr.finish();

    const added = calls.reactions.filter((r) => r.action === 'add' && r.name === 'partyparrot');
    expect(added).toHaveLength(1);
    expect(added[0].ts).toBe('stream-ts'); // the answer stream (the only bot message)
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
    sr.onTextDelta('hi'); // startStream → add fired (gated, in-flight)
    await microtasks();

    const finishP = sr.finish();
    await microtasks();
    // The add is still gated, so finish() must NOT have removed yet.
    expect(calls.reactions.some((r) => r.action === 'remove')).toBe(false);

    releaseAdd();
    await finishP;
    // Order is add-then-remove; the reaction never ends up stuck.
    expect(calls.reactions.map((r) => r.action)).toEqual(['add', 'remove']);
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

  it('collapses reasoning and tool steps into a working-notes attachment, keeping the answer', async () => {
    const { client, calls } = createMockClient();
    const responder = makeCollapsingResponder(client);
    const sr = responder.createStreamingResponder();

    // Reasoning streams first (as it does in real Claude output), so the notes
    // stream opens before the answer stream and stays above it.
    sr.onReasoningDelta?.('Let me think about the GCD approach.');
    await microtasks();
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'config.ts' });
    await microtasks();
    sr.onTextDelta('The answer is 42.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('The answer is 42.', sr);

    // The notes stream (opened first) is branded with the working-notes prefix.
    const start = calls.sends.find((s) => s.kind === 'start');
    expect(start?.text?.startsWith('🧠')).toBe(true);
    // Notes collapsed IN PLACE on the notes ts (above the answer) as an attachment.
    const notesUpdate = calls.updates.find((u) => Array.isArray(u.attachments));
    expect(notesUpdate?.ts).toBe('stream-ts');
    const notes = notesAttachmentText(calls);
    expect(notes).toContain('Let me think about the GCD approach.'); // reasoning
    expect(notes).toContain('config.ts'); // tool step
    expect(notes).not.toContain('The answer is 42.'); // answer not duplicated in notes
    // Clean answer streamed to its own (second) message and kept as-is — no rebuild.
    expect(calls.uploads).toHaveLength(0);
    expect(calls.updates.some((u) => u.ts === 'stream-ts-2')).toBe(false);
  });

  it('moves inter-tool narration into the notes and rebuilds the answer verbatim', async () => {
    const { client, calls } = createMockClient();
    const responder = makeCollapsingResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onReasoningDelta?.('Planning the steps.');
    await microtasks();
    sr.onTextDelta('Let me check the files first.'); // narration (a tool follows)
    await microtasks();
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'a.ts' });
    await microtasks();
    sr.onTextDelta('Done — the answer is 42.'); // the real answer (nothing follows)
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Done — the answer is 42.', sr);

    const notes = notesAttachmentText(calls);
    expect(notes).toContain('Planning the steps.'); // reasoning
    expect(notes).toContain('Let me check the files first.'); // narration archived
    expect(notes).not.toContain('Done — the answer is 42.'); // answer not in notes
    // The narration leaked into the live answer stream, so the answer is rebuilt
    // in place from result.text on the answer ts.
    const answerUpdate = calls.updates.find((u) => u.ts === 'stream-ts-2');
    expect(answerUpdate?.text).toBe('Done — the answer is 42.');
    // No live duplication: narration was archived in the notes attachment but NOT
    // streamed to the live notes message (it was already visible in the answer
    // bubble). The notes stream's wire (ts 'stream-ts') carries only reasoning/tools.
    const notesWire = calls.sends
      .filter((s) => s.ts === 'stream-ts')
      .map((s) => s.text ?? '')
      .join('');
    expect(notesWire).toContain('Planning the steps.'); // reasoning streamed live
    expect(notesWire).not.toContain('Let me check the files first.'); // narration NOT streamed live
  });

  it('separates a tool step from reasoning that resumes after it', async () => {
    // Regression: reasoning that resumes after a tool/subagent line must not run
    // onto the same line as the tool step.
    const { client, calls } = createMockClient();
    const responder = makeCollapsingResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onReasoningDelta?.('First thought.');
    await microtasks();
    sr.onToolEvent({ phase: 'complete', toolName: 'Read', keyArg: 'x.ts' });
    await microtasks();
    sr.onReasoningDelta?.('Second thought after the tool.');
    await microtasks();
    sr.onTextDelta('Answer.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Answer.', sr);

    const notes = notesAttachmentText(calls) ?? '';
    // The tool line and the resumed reasoning are on separate lines, not glued.
    expect(notes).not.toMatch(/x\.ts`_Second thought/);
    expect(notes).toContain('First thought.');
    expect(notes).toContain('Second thought after the tool.');
    // There is a newline between the tool step and the resumed reasoning.
    expect(notes).toMatch(/x\.ts`_\n+.*Second thought after the tool\./s);
  });

  it('reuses the thinking placeholder as the tool status (no double message) when collapse is off', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client); // collapse disabled
    const sr = responder.createStreamingResponder();

    // Tool fires before any answer text — old behaviour reused the single
    // "thinking…" bubble as the status rather than posting a second message.
    await microtasks(); // let the placeholder post resolve (posted-1)
    sr.onToolEvent({ phase: 'complete', toolName: 'Bash', keyArg: 'ls' });
    await microtasks();

    // Only the placeholder was posted; the tool status edits it in place.
    expect(calls.posts).toHaveLength(1);
    expect(calls.updates.some((u) => u.ts === 'posted-1')).toBe(true);

    sr.onTextDelta('Done.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Done.', sr);

    // When the answer stream opened, the adopted placeholder/status bubble was removed.
    expect(calls.deletes.some((d) => d.ts === 'posted-1')).toBe(true);
  });

  it('keeps the live answer and creates no notes for an answer-only turn', async () => {
    const { client, calls } = createMockClient();
    const responder = makeCollapsingResponder(client);
    const sr = responder.createStreamingResponder();

    // No reasoning/tools/narration — straight to the answer.
    sr.onTextDelta('The answer is 42.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('The answer is 42.', sr);

    // No notes stream opened, nothing collapsed.
    expect(calls.updates.some((u) => Array.isArray(u.attachments))).toBe(false);
    // Clean answer streamed live and kept as-is (no rebuild, no upload).
    expect(calls.updates).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
    // Only one stream was ever opened (the answer).
    expect(calls.sends.filter((s) => s.kind === 'start')).toHaveLength(1);
  });

  it('leaves the live message untouched when collapseWorkingNotes is false', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client); // collapse disabled
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Let me check.');
    await microtasks();
    sr.onToolEvent({ phase: 'start', toolName: 'Read' });
    await microtasks();
    sr.onTextDelta('Answer: 42.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Answer: 42.', sr);

    // No prefix added, no collapse, no in-place rewrite.
    const start = calls.sends.find((s) => s.kind === 'start');
    expect(start?.text?.startsWith('🧠')).toBe(false);
    expect(calls.uploads).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
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

  it('folds the detail section into an attachment and trims the answer bubble', async () => {
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

    // The live answer bubble is rebuilt in place to hold only the TL;DR.
    expect(calls.updates.some((u) => u.ts === 'stream-ts' && u.text === 'TL;DR answer')).toBe(true);
    // The detail section is posted as a separate attachment after the answer.
    const detailPost = calls.posts.find((p) => Array.isArray(p.attachments));
    expect(detailPost).toBeDefined();
    expect((detailPost!.attachments as Array<{ text?: string }>)[0].text).toContain(
      'the long version',
    );
  });

  it('does not post a detail attachment when no marker is present', async () => {
    const { client, calls } = createMockClient();
    const responder = makeResponder(client);
    const sr = responder.createStreamingResponder();

    sr.onTextDelta('Just the answer.');
    await microtasks();
    await sr.finish();
    await responder.onStreamComplete('Just the answer.', sr);

    expect(calls.posts.some((p) => Array.isArray(p.attachments))).toBe(false);
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
