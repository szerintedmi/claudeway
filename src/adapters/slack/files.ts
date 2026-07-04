import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { DATA_DIR } from '../../config.js';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

const FILE_SIZE_LIMIT = 25 * 1024 * 1024; // 25MB
export const FILE_TEMP_BASE = resolve(DATA_DIR, 'files');

export interface DownloadResult {
  paths: string[];
  /** file id → local path, for building per-file attachment metadata */
  pathsById: Map<string, string>;
  failedCount: number;
  totalCount: number;
}

export async function downloadSlackFiles(
  files: SlackFile[],
  token: string,
  channelId: string,
): Promise<DownloadResult> {
  const downloadable = files.filter((f) => f.url_private_download && f.size <= FILE_SIZE_LIMIT);
  if (downloadable.length === 0)
    return { paths: [], pathsById: new Map(), failedCount: 0, totalCount: 0 };

  const dir = join(FILE_TEMP_BASE, channelId);
  mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  const pathsById = new Map<string, string>();
  let failedCount = 0;
  for (const file of downloadable) {
    try {
      const res = await fetch(file.url_private_download!, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`[files] Failed to download ${file.name}: HTTP ${res.status}`);
        failedCount++;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const localPath = join(dir, `${file.id}-${file.name}`);
      writeFileSync(localPath, buffer);
      paths.push(localPath);
      pathsById.set(file.id, localPath);
      console.log(`[files] Downloaded ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error(`[files] Failed to download ${file.name}:`, err);
      failedCount++;
    }
  }
  return { paths, pathsById, failedCount, totalCount: downloadable.length };
}
