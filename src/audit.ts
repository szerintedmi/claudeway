import { appendFileSync, chmodSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Append-only JSONL audit log for credential events and credentialed spawns.
 * Records names and outcomes ONLY — never secret values.
 */

export type AuditEvent =
  | 'spawn'
  | 'spawn.denied'
  | 'creds.set'
  | 'creds.deleted'
  | 'link.issued'
  | 'link.redeemed'
  | 'link.rejected';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  /** Canonical user id the event concerns. */
  userId: string;
  userName?: string;
  channelId?: string;
  /** Credential names involved (never values). */
  credNames?: string[];
  /** Free-form detail (e.g. rejection reason, acting user for owner revocations). */
  detail?: string;
}

export const AUDIT_FILE = '.claudeway-audit.jsonl';

let auditBaseDir: string | undefined;

/** Override the audit log directory (tests). */
export function setAuditBaseDir(dir: string | undefined): void {
  auditBaseDir = dir;
}

export function auditFilePath(baseDir?: string): string {
  return resolve(baseDir ?? auditBaseDir ?? process.cwd(), AUDIT_FILE);
}

export function audit(entry: Omit<AuditEntry, 'ts'>, baseDir?: string): void {
  const path = auditFilePath(baseDir);
  const isNew = !existsSync(path);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    appendFileSync(path, line, 'utf-8');
    if (isNew) chmodSync(path, 0o600);
  } catch (err) {
    // Auditing must never break message processing — but make failures visible
    console.error(
      '[audit] Failed to append audit entry:',
      err instanceof Error ? err.message : err,
    );
  }
}
