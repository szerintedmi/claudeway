import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';

/**
 * Ensure a persistent per-channel scratch directory exists.
 * Returns the path to `.claudeway-tmp/scratch/<channelId>/`.
 * Unlike per-request temp dirs, scratch dirs persist across messages.
 */
export function ensureScratchDir(baseDir: string, channelId: string): string {
  const dir = join(baseDir, 'scratch', channelId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a per-request temporary directory within the configured base temp dir.
 * Also writes a pointer file (<channelId>.current) so the claudeway-attach script
 * can find the current request's temp dir in persistent process mode.
 */
export function createRequestTempDir(baseDir: string, channelId: string): string {
  mkdirSync(baseDir, { recursive: true });
  const requestDir = mkdtempSync(join(baseDir, 'req-'));

  // Write pointer file for persistent mode (claudeway-attach reads this)
  const pointerPath = join(baseDir, `${channelId}.current`);
  writeFileSync(pointerPath, requestDir, 'utf-8');

  return requestDir;
}

/**
 * Read the attachment manifest from a request temp directory.
 * Returns absolute paths to files that should be uploaded.
 * Skips paths that no longer exist (best effort).
 */
export function readAttachmentManifest(requestDir: string): string[] {
  const manifestPath = join(requestDir, 'attachments.txt');
  if (!existsSync(manifestPath)) return [];

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

/**
 * Remove the request temp directory and its pointer file.
 * Safe to call even if they don't exist.
 */
export function cleanupRequestTempDir(
  requestDir: string,
  baseDir: string,
  channelId: string,
): void {
  try {
    rmSync(requestDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
  // Remove pointer file if it still points to this request dir
  try {
    const pointerPath = join(baseDir, `${channelId}.current`);
    if (existsSync(pointerPath) && readFileSync(pointerPath, 'utf-8').trim() === requestDir) {
      rmSync(pointerPath, { force: true });
    }
  } catch {
    // Best effort
  }
}

/**
 * Return the newest mtime (ms) of any file in a directory tree.
 * Returns 0 if the directory is empty or unreadable.
 */
function newestMtimeMs(dir: string): number {
  let max = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          max = Math.max(max, newestMtimeMs(full));
        } else {
          max = Math.max(max, stat.mtimeMs);
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // dir unreadable
  }
  return max;
}

/**
 * Delete stale temp artifacts at startup. Covers three systems:
 * 1. Slack download files in fileTempBase (.docker/files/)
 * 2. Orphaned req-* dirs and *.current pointer files in tempBaseDir
 * 3. Scratch dirs in tempBaseDir/scratch/ (uses newest file mtime in subtree)
 *
 * Does nothing if tempMaxAgeDays <= 0.
 */
export function cleanupStaleTempFiles(
  tempMaxAgeDays: number,
  tempBaseDir: string,
  fileTempBase: string,
): void {
  if (tempMaxAgeDays <= 0) return;

  const cutoff = Date.now() - tempMaxAgeDays * 24 * 60 * 60 * 1000;

  // 1. Slack download files
  if (existsSync(fileTempBase)) {
    try {
      for (const channelDir of readdirSync(fileTempBase)) {
        const channelPath = join(fileTempBase, channelDir);
        try {
          for (const name of readdirSync(channelPath)) {
            const filepath = join(channelPath, name);
            try {
              if (statSync(filepath).mtimeMs < cutoff) {
                unlinkSync(filepath);
                console.log(`[cleanup] Removed old temp file: ${channelDir}/${name}`);
              }
            } catch {
              // ignore per-file errors
            }
          }
          // Remove empty channel dirs
          try {
            if (readdirSync(channelPath).length === 0) {
              rmSync(channelPath, { recursive: true, force: true });
            }
          } catch {
            // ignore
          }
        } catch {
          // not a directory or read failed
        }
      }
    } catch {
      // base dir read failed
    }
  }

  if (!existsSync(tempBaseDir)) return;

  // 2. Orphaned req-* dirs and stale *.current pointer files
  try {
    for (const entry of readdirSync(tempBaseDir)) {
      const fullPath = join(tempBaseDir, entry);
      try {
        const stat = statSync(fullPath);
        if (entry.startsWith('req-') && stat.isDirectory()) {
          const newest = newestMtimeMs(fullPath);
          // Fall back to dir mtime when empty (don't delete fresh empty dirs)
          const effectiveMtime = newest > 0 ? newest : stat.mtimeMs;
          if (effectiveMtime < cutoff) {
            rmSync(fullPath, { recursive: true, force: true });
            console.log(`[cleanup] Removed orphaned request dir: ${entry}`);
          }
        } else if (entry.endsWith('.current') && stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(fullPath);
          console.log(`[cleanup] Removed stale pointer file: ${entry}`);
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // tempBaseDir read failed
  }

  // 3. Scratch dirs — use newest file mtime in subtree
  const scratchBase = join(tempBaseDir, 'scratch');
  if (!existsSync(scratchBase)) return;
  try {
    for (const channelDir of readdirSync(scratchBase)) {
      const channelPath = join(scratchBase, channelDir);
      try {
        const dirStat = statSync(channelPath);
        if (!dirStat.isDirectory()) continue;
        const newest = newestMtimeMs(channelPath);
        // Fall back to dir mtime when empty (don't delete fresh empty dirs)
        const effectiveMtime = newest > 0 ? newest : dirStat.mtimeMs;
        if (effectiveMtime < cutoff) {
          rmSync(channelPath, { recursive: true, force: true });
          console.log(`[cleanup] Removed stale scratch dir: ${channelDir}`);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // scratch dir read failed
  }
}
