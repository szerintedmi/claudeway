import type { TriggerMode, UserPermissions } from './config.js';

export interface ThreadMessage {
  authorName: string;
  isBot: boolean;
  text: string;
}

export function shouldRespond(
  text: string | undefined,
  botUserId: string,
  triggerMode: TriggerMode,
): boolean {
  if (triggerMode === 'all') return true;
  return !!text && text.includes(`<@${botUserId}>`);
}

export function formatThreadContext(messages: ThreadMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) => `[${m.authorName}]: ${m.text}`);
  return (
    `[Thread context — ${messages.length} prior message${messages.length !== 1 ? 's' : ''}]\n\n` +
    lines.join('\n') +
    '\n\n[Current message]\n'
  );
}

/**
 * Extract all unique Slack user IDs (`<@UXXXXXX>`) from one or more text strings.
 */
export function extractMentionedUserIds(...texts: string[]): string[] {
  const mentionPattern = /<@(U[A-Z0-9]+)>/g;
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(mentionPattern)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

/**
 * Build a user directory block mapping Slack user IDs to display names.
 * Injected at the top of the prompt so the bot understands who `<@UXXXXXX>` refers to
 * and can use the same syntax in its own replies.
 */
export function formatUserDirectory(
  entries: Array<{ id: string; name: string }>,
  botUserId?: string,
  headerLabel = 'Slack user reference',
): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) =>
    e.id === botUserId ? `<@${e.id}> = ${e.name} (you)` : `<@${e.id}> = ${e.name}`,
  );
  return `[${headerLabel}]\n` + lines.join('\n') + '\n\n';
}

export function buildPrompt(
  text: string,
  threadMessages: ThreadMessage[],
  userDirectory: Array<{ id: string; name: string }> = [],
  botUserId?: string,
): string {
  const directory = formatUserDirectory(userDirectory, botUserId);
  const context = formatThreadContext(threadMessages);
  return directory + context + text;
}

/**
 * Build access restriction text to append to the system prompt.
 * Returns '' if the user has full access (both git and jiraWrite).
 */
export function buildAccessRestrictions(permissions: UserPermissions, scratchDir: string): string {
  if (permissions.git && permissions.jiraWrite) return '';

  const lines: string[] = ['## Access restrictions for this user', ''];
  lines.push('You are operating in READ-ONLY mode for this user.');

  if (!permissions.git) {
    lines.push('- Do NOT modify, create, or delete any files in the repository');
    lines.push(
      '- Do NOT run git commit, git push, git checkout, git stash, or any git commands that modify state',
    );
  }

  if (!permissions.jiraWrite) {
    lines.push('- Do NOT create, update, or delete Jira tickets or Confluence pages');
  }

  lines.push(
    '- You MAY read files, search code, run git log/diff/show, and search Jira/Confluence',
  );
  lines.push(
    `- You MAY write files to ${scratchDir} — this is a shared workspace that persists across messages in this channel`,
  );
  lines.push(
    '- You MAY write temporary files to $CLAUDEWAY_TEMP_DIR for one-off outputs (e.g., file attachments)',
  );
  lines.push(
    '- If the user asks you to do something restricted, explain that they have read-only access',
  );

  return '\n\n' + lines.join('\n');
}

/**
 * Append access restrictions to a system prompt if needed.
 */
export function appendAccessRestrictions(
  systemPrompt: string,
  permissions: UserPermissions,
  scratchDir: string,
): string {
  const restrictions = buildAccessRestrictions(permissions, scratchDir);
  return restrictions ? systemPrompt + restrictions : systemPrompt;
}
