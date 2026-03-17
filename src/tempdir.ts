import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
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
