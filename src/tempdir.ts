import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'fs';
import { join } from 'path';
import { sanitize } from './path-safety.js';

/**
 * Per-session temp directory management.
 *
 * One directory per resolved Claude session holds everything for a
 * conversation: inbound downloads (`incoming/`), generic tool temp (`tmp/`,
 * the `$TMPDIR` target), Claude's generated working files (at the root), and
 * the outbound upload manifest (`.attachments`). Everything persists across
 * turns within the session; a single age-based GC reclaims the whole tree.
 *
 * Layout (see docs/plans/2026-07-04-temp-dir-consolidation.md):
 *
 *   <baseDir>/<sanitize(channelId)>/<sessionId>/   ← $CLAUDEWAY_TEMP_DIR
 *     incoming/                                     ← inbound downloads
 *     tmp/                                          ← $TMPDIR (generic tool temp)
 *     .attachments                                  ← outbound upload manifest
 *     .last-used                                    ← touched every turn; GC keys off this
 *     <root>                                        ← Claude's workspace
 */

export const INCOMING_SUBDIR = 'incoming';
export const ENV_TMP_SUBDIR = 'tmp';
export const ATTACHMENTS_FILE = '.attachments';
export const LAST_USED_MARKER = '.last-used';

/** `<sessionTempDir>/incoming` — inbound (sender-named) downloads. */
export function resolveIncomingDir(sessionTempDir: string): string {
  return join(sessionTempDir, INCOMING_SUBDIR);
}

/**
 * `<sessionTempDir>/tmp` — the target for the `$TMPDIR`-family env vars
 * (`TMPDIR`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_TMPDIR`), i.e. env-driven *implicit*
 * temp (mktemp, Python `tempfile`, the CLI's own internal scratch). Kept in a
 * subfolder so it stays out of the session root, where Claude's deliberate
 * working files live (D8).
 */
export function envTmpDir(sessionTempDir: string): string {
  return join(sessionTempDir, ENV_TMP_SUBDIR);
}

/** Touch the `.last-used` marker so age-based GC sees recent activity (D7). */
function touchLastUsed(sessionTempDir: string): void {
  const marker = join(sessionTempDir, LAST_USED_MARKER);
  try {
    if (existsSync(marker)) {
      const now = new Date();
      utimesSync(marker, now, now);
    } else {
      writeFileSync(marker, '', 'utf-8');
    }
  } catch {
    // best effort
  }
}

/**
 * Create (or reuse) the temp directory for a resolved Claude session and return
 * its path. Ensures `incoming/` and `tmp/` exist and touches `.last-used` on
 * every call so an active session survives GC even on turns that write nothing
 * under the dir (D7). Keyed by the resolved `sessionId` so the temp bucket is
 * 1:1 with the Claude transcript (D1); `channelId` is a sanitized parent for
 * human-readable grouping (`sessionId` is a UUID and needs no sanitizing).
 */
export function resolveSessionTempDir(
  baseDir: string,
  channelId: string,
  sessionId: string,
): string {
  const dir = join(baseDir, sanitize(channelId), sessionId);
  mkdirSync(resolveIncomingDir(dir), { recursive: true });
  mkdirSync(envTmpDir(dir), { recursive: true });
  touchLastUsed(dir);
  return dir;
}

/**
 * Read the outbound attachment manifest (`<sessionTempDir>/.attachments`).
 * Returns absolute paths that should be uploaded, skipping ones that no longer
 * exist (best effort).
 */
export function readAttachmentManifest(sessionTempDir: string): string[] {
  const manifestPath = join(sessionTempDir, ATTACHMENTS_FILE);
  if (!existsSync(manifestPath)) return [];
  try {
    return readFileSync(manifestPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

/**
 * Return the manifest's paths, then clear the manifest ONLY (files are left on
 * disk). Clearing prevents re-uploading every previously-staged file on the
 * next turn; keeping the files lets Claude re-read/re-send them later by path.
 */
export function drainAttachmentManifest(sessionTempDir: string): string[] {
  const paths = readAttachmentManifest(sessionTempDir);
  const manifestPath = join(sessionTempDir, ATTACHMENTS_FILE);
  try {
    rmSync(manifestPath, { force: true });
  } catch {
    // best effort — files still uploaded; a lingering manifest re-uploads next turn
  }
  return paths;
}

function safeReaddirDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** UUID shape of a resolved session id (the only dirs this GC reaps). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete stale session temp dirs at startup. Walks
 * `<baseDir>/<channelId>/<sessionId>` and keys each session off its
 * `.last-used` marker mtime (falling back to the dir's own mtime), so a session
 * kept active by text-only turns — which touch the marker but write no files —
 * is preserved. One retention (`tempMaxAgeDays`). Does nothing when
 * `tempMaxAgeDays <= 0`.
 *
 * Only reaps leaf dirs whose name is a UUID session id; anything else under the
 * base (e.g. non-session dirs) is left untouched.
 */
export function cleanupStaleTempDirs(tempMaxAgeDays: number, baseDir: string): void {
  if (tempMaxAgeDays <= 0) return;
  if (!existsSync(baseDir)) return;

  const cutoff = Date.now() - tempMaxAgeDays * 24 * 60 * 60 * 1000;

  for (const channelDir of safeReaddirDirs(baseDir)) {
    const channelPath = join(baseDir, channelDir);
    for (const sessionDir of safeReaddirDirs(channelPath)) {
      if (!SESSION_ID_RE.test(sessionDir)) continue;
      const dir = join(channelPath, sessionDir);
      try {
        const marker = join(dir, LAST_USED_MARKER);
        const mtime = existsSync(marker) ? statSync(marker).mtimeMs : statSync(dir).mtimeMs;
        if (mtime >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
        console.log(`[cleanup] Removed stale session temp dir: ${channelDir}/${sessionDir}`);
      } catch {
        // skip unreadable entries
      }
    }
    // Remove now-empty channel dirs
    try {
      if (readdirSync(channelPath).length === 0) {
        rmSync(channelPath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
