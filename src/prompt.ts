import type { TriggerMode } from './config.js';
import type { CredentialStatus } from './credentials.js';
import { credsDmInstruction } from './creds-hint.js';

export function shouldRespond(
  text: string | undefined,
  botUserId: string,
  triggerMode: TriggerMode,
): boolean {
  if (triggerMode === 'all') return true;
  return !!text && text.includes(`<@${botUserId}>`);
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
