import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import type { WebClient } from '@slack/web-api';
import { warnInThread } from './slack-utils.js';

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
 * Upload all files from the attachment manifest to Slack.
 * Non-critical — errors are logged but do not throw.
 */
export async function uploadAttachedFiles(
  requestDir: string,
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const filePaths = readAttachmentManifest(requestDir);
  if (filePaths.length === 0) return;

  console.log(`[attachments] Uploading ${filePaths.length} file(s)`);

  const failed: string[] = [];

  for (const filePath of filePaths) {
    const filename = basename(filePath);
    try {
      await client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file: filePath,
        filename,
        title: filename,
      });
      console.log(`[attachments] Uploaded: ${filename}`);
    } catch (err) {
      const slackErr = err as { data?: unknown };
      const detail = slackErr.data ? JSON.stringify(slackErr.data, null, 2) : err;
      console.error(`[attachments] Failed to upload ${filename}:`, detail);
      failed.push(filename);
    }
  }

  if (failed.length > 0) {
    const fileList = failed.join(', ');
    await warnInThread(
      client,
      channelId,
      threadTs,
      `Failed to upload ${failed.length} attachment(s): ${fileList}`,
    );
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
