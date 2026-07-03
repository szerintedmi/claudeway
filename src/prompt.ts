import type { TriggerMode } from './config.js';
import type { CredentialStatus } from './credentials.js';
import { credsDmInstruction } from './creds-hint.js';

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
 * Agent-facing credential status block, appended to the system prompt.
 *
 * Lists only credentials the user is NOT running on a personal token for —
 * shared defaults (with their config-declared capability note) and unresolved
 * ones — so the agent can refuse doomed operations preemptively and point the
 * user at `!creds` instead of attempting a write that fails. Returns '' when
 * every credential resolved personally (no prompt noise for enrolled users).
 *
 * Persistent-mode consistency: this block derives entirely from credential
 * resolution, and the engine already respawns the persistent process when the
 * resolved credential-value hash changes — so enrolling via `!creds` refreshes
 * the block on the user's next turn.
 */
export function buildCredentialStatus(statuses: CredentialStatus[], userLabel: string): string {
  const limited = statuses.filter((s) => s.source !== 'personal');
  if (limited.length === 0) return '';

  const lines: string[] = [`## Credential status for ${userLabel}`, ''];
  for (const s of limited) {
    if (s.source === 'shared') {
      lines.push(
        `- ${s.name} (${s.label}): using the SHARED default token${s.note ? ` — ${s.note}` : ''}. No personal token connected.`,
      );
    } else {
      lines.push(
        `- ${s.name} (${s.label}): NO credential available — operations needing it will fail.`,
      );
    }
  }
  lines.push('');
  lines.push(
    'If the user asks for an operation these credentials cannot perform, do NOT attempt it — it will fail. ' +
      'Instead, name the limiting credential and tell them they can ' +
      `${credsDmInstruction('connect their own token')}, then retry.`,
  );

  return '\n\n' + lines.join('\n');
}
