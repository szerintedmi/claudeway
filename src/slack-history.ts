import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './config.js';

/**
 * Per-Claude-session Slack history watermark: the last Slack message ts that
 * was handed to this session (as injected context or as the current message).
 * One file per session id under DATA_DIR/slack-history/ — per-session files
 * avoid write contention between concurrently draining channels.
 *
 * Deleting a state file is always safe: with a live session artifact but no
 * watermark, the coordinator falls back to injecting the full prior thread
 * once and re-establishes it.
 */
export interface SlackHistoryState {
  sessionId: string;
  channelId: string;
  threadTs: string;
  lastSeenSlackTs: string;
}

const HISTORY_DIR = join(DATA_DIR, 'slack-history');

// Watermarks matter only while the Claude session artifact exists; the Claude
// CLI's own transcript cleanup defaults to 30 days, so mirror that here.
export const DEFAULT_SLACK_HISTORY_MAX_AGE_DAYS = 30;

function stateFile(sessionId: string): string {
  // Session ids are UUIDs (deriveSessionId), so they are filename-safe as-is.
  return join(HISTORY_DIR, `${sessionId}.json`);
}

export function loadSlackHistoryState(sessionId: string): SlackHistoryState | null {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), 'utf-8')) as SlackHistoryState;
  } catch {
    return null;
  }
}

export function saveSlackHistoryState(state: SlackHistoryState): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(stateFile(state.sessionId), JSON.stringify(state, null, 2), 'utf-8');
}

export function deleteSlackHistoryState(sessionId: string): void {
  try {
    unlinkSync(stateFile(sessionId));
  } catch {
    // Already gone — fine
  }
}

/**
 * Compare two Slack timestamps ("1710000000.000100"). Numeric compare of the
 * seconds and fractional parts as integers — parseFloat would lose precision
 * at microsecond granularity.
 */
export function compareSlackTs(a: string, b: string): number {
  const [aSec, aFrac = ''] = a.split('.');
  const [bSec, bFrac = ''] = b.split('.');
  const sec = Number(aSec) - Number(bSec);
  if (sec !== 0) return Math.sign(sec);
  const width = Math.max(aFrac.length, bFrac.length);
  return Math.sign(Number(aFrac.padEnd(width, '0')) - Number(bFrac.padEnd(width, '0')));
}

/** Startup GC: drop watermark files idle past maxAgeDays (by file mtime). */
export function cleanupStaleSlackHistory(
  maxAgeDays: number = DEFAULT_SLACK_HISTORY_MAX_AGE_DAYS,
): number {
  let removed = 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const f of files) {
    const path = join(HISTORY_DIR, f);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // File vanished or unreadable — skip
    }
  }
  if (removed > 0) console.log(`[startup] Removed ${removed} stale Slack history watermark(s)`);
  return removed;
}
