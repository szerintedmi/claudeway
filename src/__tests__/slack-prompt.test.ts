import { describe, it, expect } from 'bun:test';
import {
  formatFileSize,
  slackFileRef,
  formatFileMetaLine,
  formatEntryPrefix,
  formatEntry,
  renderSlackPrompt,
  type SlackPromptEntry,
} from '../adapters/slack/prompt.js';

const CH = 'C123';
const THREAD = '1710000000.000100';

const current: SlackPromptEntry = {
  ts: '1710000120.000400',
  userId: 'U333',
  authorName: 'Cara',
  text: '<@UBOT> please review that log',
};

function render(opts: Partial<Parameters<typeof renderSlackPrompt>[0]> = {}) {
  return renderSlackPrompt({
    channelId: CH,
    threadTs: THREAD,
    newSession: false,
    botUserId: 'UBOT',
    botName: 'Claudeway',
    context: [],
    current,
    ...opts,
  });
}

describe('formatFileSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(14336)).toBe('14 KB');
    expect(formatFileSize(2.1 * 1024 * 1024)).toBe('2.1 MB');
  });

  it('handles unknown sizes', () => {
    expect(formatFileSize(undefined)).toBe('unknown');
  });
});

describe('formatEntryPrefix', () => {
  it('includes ts, Slack id, and display name', () => {
    expect(formatEntryPrefix({ ts: '100.1', userId: 'U1', authorName: 'Alice', text: 'x' })).toBe(
      '[100.1 <@U1> Alice]',
    );
  });

  it('degrades to id-only when the name is unresolvable', () => {
    expect(formatEntryPrefix({ ts: '100.1', userId: 'U1', text: 'x' })).toBe('[100.1 <@U1>]');
  });

  it('labels our own bot with (you)', () => {
    expect(
      formatEntryPrefix({
        ts: '100.1',
        userId: 'UBOT',
        authorName: 'Claudeway',
        isSelfBot: true,
        isBot: true,
        text: 'x',
      }),
    ).toBe('[100.1 <@UBOT> Claudeway (you)]');
  });

  it('labels third-party bots with (bot), name-only when they have no user id', () => {
    expect(formatEntryPrefix({ ts: '100.1', authorName: 'Jira', isBot: true, text: 'x' })).toBe(
      '[100.1 Jira (bot)]',
    );
  });
});

describe('attachment metadata lines', () => {
  it('renders metadata + opaque ref, no Slack URLs', () => {
    const line = formatFileMetaLine(CH, '1710000110.000300', [
      { id: 'F123', name: 'logs.txt', mimetype: 'text/plain', size: 14336 },
    ]);
    expect(line).toBe(
      '{File attachment(s): name="logs.txt" id=F123 type=text/plain size=14 KB ' +
        'ref=slack-file:C123:1710000110.000300:F123}',
    );
    expect(line).not.toContain('http');
  });

  it('separates multiple files with " ; "', () => {
    const line = formatFileMetaLine(CH, '171.1', [
      { id: 'F1', name: 'a.txt', size: 10 },
      { id: 'F2', name: 'b.txt', size: 20 },
    ]);
    expect(line).toContain(' ; ');
    expect(line).toContain('name="a.txt"');
    expect(line).toContain('name="b.txt"');
  });

  it('includes path= only when a local path exists (current-message downloads)', () => {
    const line = formatFileMetaLine(CH, '171.1', [
      { id: 'F9', name: 'trace.json', localPath: '/tmp/F9-trace.json' },
      { id: 'F8', name: 'huge.bin', size: 999999999 },
    ]);
    expect(line).toContain('ref=slack-file:C123:171.1:F9 path=/tmp/F9-trace.json');
    expect(line).not.toContain('F8 path=');
  });

  it('slackFileRef is the opaque triple', () => {
    expect(slackFileRef('C1', '2.3', 'F4')).toBe('slack-file:C1:2.3:F4');
  });
});

describe('formatEntry', () => {
  it('renders a file-only message as prefix + attachment line', () => {
    const out = formatEntry(CH, {
      ts: '100.1',
      userId: 'U1',
      authorName: 'Alice',
      text: '',
      files: [{ id: 'F1', name: 'logs.txt', size: 100 }],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[100.1 <@U1> Alice]:');
    expect(lines[1]).toStartWith('{File attachment(s):');
  });
});

describe('renderSlackPrompt', () => {
  it('first session includes the thread header with bot identity', () => {
    const out = render({ newSession: true });
    expect(out).toContain(
      `=== Slack thread id: ${CH}/${THREAD} ; Bot (you): <@UBOT> Claudeway ===`,
    );
  });

  it('follow-up turns do not include the thread header', () => {
    const out = render({ newSession: false });
    expect(out).not.toContain('=== Slack thread id');
  });

  it('never emits a user directory block', () => {
    const out = render({ newSession: true });
    expect(out).not.toContain('[Slack user reference]');
  });

  it('injected prior messages sit under --- Slack context ---', () => {
    const out = render({
      context: [
        { ts: '1710000100.000200', userId: 'U111', authorName: 'Alice', text: 'I pushed the fix.' },
      ],
    });
    expect(out).toContain('--- Slack context ---');
    expect(out).toContain('[1710000100.000200 <@U111> Alice]: I pushed the fix.');
    // context stays above the current message, which is always the final block
    expect(out.indexOf('--- Slack context ---')).toBeLessThan(
      out.indexOf(`[${current.ts} <@U333> Cara]:`),
    );
  });

  it('omits the context section when there is nothing to inject', () => {
    expect(render({ context: [] })).not.toContain('--- Slack context ---');
  });

  it('emits no current-message id header; the message line carries ts + sender', () => {
    const out = render({});
    expect(out).not.toContain('--- Current Slack message');
    expect(out).not.toContain('From:');
    // the message line itself carries the ts and sender prefix
    expect(out).toContain(`[${current.ts} <@U333> Cara]: <@UBOT> please review that log`);
  });

  it('renders only the current message line on a follow-up with no context', () => {
    const out = render({ newSession: false, context: [] });
    expect(out).toBe(`[${current.ts} <@U333> Cara]: <@UBOT> please review that log`);
  });

  it('uses dash/equals block markers, not bracket-only headers', () => {
    const out = render({ newSession: true, context: [{ ts: '1', text: 'x' }] });
    expect(out).not.toContain('[Thread context');
    expect(out).not.toContain('[Current message]');
  });

  it('current-message attachments carry both ref= and path=', () => {
    const out = render({
      current: {
        ...current,
        files: [
          {
            id: 'F999',
            name: 'trace.json',
            mimetype: 'application/json',
            size: 41984,
            localPath: '/data/files/C123/F999-trace.json',
          },
        ],
      },
    });
    expect(out).toContain('ref=slack-file:C123:1710000120.000400:F999');
    expect(out).toContain('path=/data/files/C123/F999-trace.json');
  });

  it('prior-message attachments carry metadata refs only', () => {
    const out = render({
      context: [
        {
          ts: '1710000110.000300',
          userId: 'U222',
          authorName: 'Bob',
          text: 'logs attached',
          files: [{ id: 'F123', name: 'logs.txt', mimetype: 'text/plain', size: 14336 }],
        },
      ],
    });
    expect(out).toContain('ref=slack-file:C123:1710000110.000300:F123');
    expect(out).not.toContain('path=');
  });
});
