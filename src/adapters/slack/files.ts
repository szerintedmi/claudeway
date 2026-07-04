import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveIncomingDir } from '../../tempdir.js';
import { sanitize, isInside } from '../../path-safety.js';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

const FILE_SIZE_LIMIT = 25 * 1024 * 1024; // 25MB

export interface DownloadResult {
  paths: string[];
  /** file id → local path, for building per-file attachment metadata */
  pathsById: Map<string, string>;
  failedCount: number;
  /** Files skipped because they exceeded FILE_SIZE_LIMIT. */
  oversizedCount: number;
  totalCount: number;
}

/**
 * Download current-message Slack files into the session's `incoming/` dir (D10:
 * called at processing time, keyed by the resolved session, not eagerly at
 * enqueue). Filenames are sender-controlled, so each is sanitized and the
 * resolved path is verified to stay inside the session dir before writing (D6);
 * the `<fileId>-` prefix additionally avoids collisions with Claude-generated
 * files of the same name.
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  token: string,
  sessionTempDir: string,
): Promise<DownloadResult> {
  const withRef = files.filter((f) => f.url_private_download);
  const downloadable = withRef.filter((f) => f.size <= FILE_SIZE_LIMIT);
  const oversizedCount = withRef.length - downloadable.length;
  if (downloadable.length === 0)
    return { paths: [], pathsById: new Map(), failedCount: 0, oversizedCount, totalCount: 0 };

  const dir = resolveIncomingDir(sessionTempDir);
  mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  const pathsById = new Map<string, string>();
  let failedCount = 0;
  for (const file of downloadable) {
    try {
      const localPath = join(dir, sanitize(`${file.id}-${file.name}`));
      // Defence-in-depth: a crafted name must not escape the session dir.
      if (!isInside(sessionTempDir, localPath)) {
        console.error(`[files] Refusing unsafe download path for ${file.name}`);
        failedCount++;
        continue;
      }
      const res = await fetch(file.url_private_download!, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`[files] Failed to download ${file.name}: HTTP ${res.status}`);
        failedCount++;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buffer);
      paths.push(localPath);
      pathsById.set(file.id, localPath);
      console.log(`[files] Downloaded ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error(`[files] Failed to download ${file.name}:`, err);
      failedCount++;
    }
  }
  return { paths, pathsById, failedCount, oversizedCount, totalCount: downloadable.length };
}
