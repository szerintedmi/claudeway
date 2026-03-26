import { describe, it, expect } from 'bun:test';
import { extractTextFromAttachments, type SlackAttachment } from '../adapters/slack/attachments.js';
import { shouldRespond } from '../prompt.js';

const BOT_ID = 'U_BOT';

describe('extractTextFromAttachments', () => {
  it('returns empty string for undefined attachments', () => {
    expect(extractTextFromAttachments(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextFromAttachments([])).toBe('');
  });

  it('extracts text from a shared message attachment', () => {
    const attachments: SlackAttachment[] = [
      {
        is_share: true,
        author_name: 'Alice',
        text: 'Hello from the other channel',
        fallback: '[Alice]: Hello from the other channel',
      },
    ];
    const result = extractTextFromAttachments(attachments);
    expect(result).toContain('From Alice:');
    expect(result).toContain('Hello from the other channel');
  });

  it('falls back to fallback when text is missing', () => {
    const attachments: SlackAttachment[] = [
      {
        is_share: true,
        fallback: 'Fallback content here',
      },
    ];
    expect(extractTextFromAttachments(attachments)).toContain('Fallback content here');
  });

  it('includes pretext and title when present', () => {
    const attachments: SlackAttachment[] = [
      {
        pretext: 'Shared from #general',
        title: 'Important announcement',
        text: 'The body text',
      },
    ];
    const result = extractTextFromAttachments(attachments);
    expect(result).toContain('Shared from #general');
    expect(result).toContain('Important announcement');
    expect(result).toContain('The body text');
  });

  it('handles multiple attachments', () => {
    const attachments: SlackAttachment[] = [
      { text: 'First shared message', author_name: 'Alice' },
      { text: 'Second shared message', author_name: 'Bob' },
    ];
    const result = extractTextFromAttachments(attachments);
    expect(result).toContain('First shared message');
    expect(result).toContain('Second shared message');
    expect(result).toContain('From Alice:');
    expect(result).toContain('From Bob:');
  });

  it('skips attachments with no extractable text', () => {
    const attachments: SlackAttachment[] = [{ is_share: true, from_url: 'https://example.com' }];
    expect(extractTextFromAttachments(attachments)).toBe('');
  });
});

describe('shouldRespond with attachment text (mention mode)', () => {
  it('returns true when bot is mentioned in combined text', () => {
    // Simulates the handler combining msg.text + attachmentText
    const combinedText = `<@${BOT_ID}> check this\nFrom Alice:\nShared content`;
    expect(shouldRespond(combinedText, BOT_ID, 'mention')).toBe(true);
  });

  it('returns false when bot is not mentioned anywhere', () => {
    const combinedText = 'From Alice:\nShared content without mention';
    expect(shouldRespond(combinedText, BOT_ID, 'mention')).toBe(false);
  });

  it('returns true in all mode even with only attachment text', () => {
    expect(shouldRespond(undefined, BOT_ID, 'all')).toBe(true);
  });

  it('returns false in mention mode when text is undefined', () => {
    expect(shouldRespond(undefined, BOT_ID, 'mention')).toBe(false);
  });
});

describe('attachment files collection', () => {
  it('collects files from attachment.files alongside msg.files', () => {
    // This tests the logic pattern used in the handler:
    // const attachmentFiles = (msg.attachments ?? []).flatMap((a) => a.files ?? []);
    // const allFiles = [...(msg.files ?? []), ...attachmentFiles];
    const msgFiles = [{ id: 'F1', url_private_download: 'https://files.slack.com/F1' }];
    const attachments = [
      {
        is_share: true,
        files: [
          { id: 'F2', url_private_download: 'https://files.slack.com/F2' },
          { id: 'F3', url_private_download: 'https://files.slack.com/F3' },
        ],
      },
    ];

    const attachmentFiles = attachments.flatMap((a) => a.files ?? []);
    const allFiles = [...msgFiles, ...attachmentFiles];

    expect(allFiles).toHaveLength(3);
    expect(allFiles.map((f) => f.id)).toEqual(['F1', 'F2', 'F3']);
  });

  it('handles no msg.files with attachment files only', () => {
    const msgFiles: { id: string; url_private_download: string }[] = [];
    const attachments = [
      {
        files: [{ id: 'F1', url_private_download: 'https://files.slack.com/F1' }],
      },
    ];

    const attachmentFiles = attachments.flatMap((a) => a.files ?? []);
    const allFiles = [...msgFiles, ...attachmentFiles];

    expect(allFiles).toHaveLength(1);
    expect(allFiles[0].id).toBe('F1');
  });

  it('handles attachments without files gracefully', () => {
    const attachments: SlackAttachment[] = [{ text: 'Just text, no files', is_share: true }];
    const attachmentFiles = attachments.flatMap((a) => a.files ?? []);
    expect(attachmentFiles).toHaveLength(0);
  });
});
