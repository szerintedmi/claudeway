import type { WebClient } from '@slack/web-api';

import type { TriggerMode } from './config.js';
import type { ThreadMessage } from './thread.js';
import { resolveUserName } from './thread.js';

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
): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) =>
    e.id === botUserId ? `<@${e.id}> = ${e.name} (you)` : `<@${e.id}> = ${e.name}`,
  );
  return '[Slack user reference]\n' + lines.join('\n') + '\n\n';
}

/**
 * Resolve user IDs to display names for the user directory.
 * Always includes `alwaysInclude` IDs (e.g. bot, sender) plus any
 * `<@U...>` mentions found in the given texts.
 */
export async function resolveUserDirectory(
  client: WebClient,
  alwaysInclude: string[],
  ...texts: string[]
): Promise<Array<{ id: string; name: string }>> {
  const mentioned = extractMentionedUserIds(...texts);
  const allIds = [...new Set([...alwaysInclude, ...mentioned])];
  if (allIds.length === 0) return [];
  const names = await Promise.all(allIds.map((id) => resolveUserName(client, id)));
  return allIds.map((id, i) => ({ id, name: names[i] }));
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
