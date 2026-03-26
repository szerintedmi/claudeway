export interface SlackAttachment {
  text?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
  from_url?: string;
  is_share?: boolean;
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
  }>;
}

/**
 * Extract readable text from Slack message attachments.
 * Used for shared/forwarded messages where content is in attachments, not msg.text.
 */
export function extractTextFromAttachments(attachments?: SlackAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const parts: string[] = [];
  for (const att of attachments) {
    const lines: string[] = [];
    if (att.pretext) lines.push(att.pretext);
    if (att.author_name) lines.push(`From ${att.author_name}:`);
    if (att.title) lines.push(att.title);
    if (att.text) lines.push(att.text);
    else if (att.fallback) lines.push(att.fallback);
    if (lines.length > 0) parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
