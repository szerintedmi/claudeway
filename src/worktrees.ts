import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { DATA_DIR, resolveFolder, type Config } from './config.js';

/**
 * Per-thread git worktrees (merged-plan decision #9): every turn of a Slack
 * thread runs in a worktree on branch `wt/<channel>/<threadTs>`, so
 * participants share files within a thread while concurrent threads on the
 * same repo are isolated from each other. The main checkout stays clean for
 * syncRepos(). Session IDs keep deriving from the LOGICAL repo folder.
 */

export const DEFAULT_THREAD_WORKTREE_MAX_AGE_DAYS = 14;

const WORKTREES_BASE = () => resolve(DATA_DIR, 'worktrees');
const MARKER_FILE = '.claudeway-last-used';

function git(args: string[], cwd: string): string {
  // Strip inherited git-context env vars (GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE
  // are exported by git to hook processes) so they can't redirect our worktree
  // operations at the target repo away from `cwd`.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return execFileSync('git', args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  })
    .toString()
    .trim();
}

function sanitize(part: string): string {
  // Collapse `..` (path traversal) before the character filter
  return part.replace(/\.\.+/g, '.').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function threadWorktreeBranch(channelId: string, threadTs: string): string {
  return `wt/${sanitize(channelId)}/${sanitize(threadTs)}`;
}

/** Overrides for tests — production callers omit them. */
export interface WorktreeOpts {
  /** Main checkout path (default: resolveFolder(repoName)). */
  repoFolder?: string;
  /** Base directory holding all worktrees (default: DATA_DIR/worktrees). */
  worktreesBase?: string;
}

export function threadWorktreePath(
  repoName: string,
  channelId: string,
  threadTs: string,
  worktreesBase?: string,
): string {
  return join(
    worktreesBase ?? WORKTREES_BASE(),
    sanitize(repoName),
    sanitize(channelId),
    sanitize(threadTs),
  );
}

/** Touch the last-used marker so GC sees recent activity. */
function touchMarker(worktreeDir: string): void {
  const marker = join(worktreeDir, MARKER_FILE);
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
 * Lazily create (or reuse) the worktree for a thread. Returns the worktree
 * path, or null when creation failed — callers fall back to the main checkout.
 */
export function ensureThreadWorktree(
  repoName: string,
  channelId: string,
  threadTs: string,
  opts: WorktreeOpts = {},
): string | null {
  const repoFolder = opts.repoFolder ?? resolveFolder(repoName);
  const dir = threadWorktreePath(repoName, channelId, threadTs, opts.worktreesBase);
  const branch = threadWorktreeBranch(channelId, threadTs);

  if (existsSync(join(dir, '.git'))) {
    touchMarker(dir);
    return dir;
  }

  try {
    mkdirSync(join(dir, '..'), { recursive: true });
    // Clear stale registrations (e.g. dir was deleted without `worktree remove`)
    try {
      git(['worktree', 'prune'], repoFolder);
    } catch {
      // non-fatal
    }
    const branchExists = (() => {
      try {
        git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoFolder);
        return true;
      } catch {
        return false;
      }
    })();
    if (branchExists) {
      git(['worktree', 'add', dir, branch], repoFolder);
    } else {
      git(['worktree', 'add', dir, '-b', branch], repoFolder);
    }
    touchMarker(dir);
    console.log(`[worktrees] Created ${dir} (${branch})`);
    return dir;
  } catch (err) {
    console.warn(
      `[worktrees] Failed to create worktree for ${channelId}:${threadTs} — falling back to main checkout:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Prune worktrees whose last activity exceeds threadWorktreeMaxAgeDays.
 * Runs at startup alongside temp cleanup. Removes the worktree and its
 * wt/<channel>/<threadTs> branch.
 */
export function cleanupStaleWorktrees(
  config: Config,
  maxAgeDays?: number,
  opts: WorktreeOpts = {},
): void {
  const days =
    maxAgeDays ?? config.defaults.threadWorktreeMaxAgeDays ?? DEFAULT_THREAD_WORKTREE_MAX_AGE_DAYS;
  if (days <= 0) return;
  const base = opts.worktreesBase ?? WORKTREES_BASE();
  if (!existsSync(base)) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const repoName of safeReaddir(base)) {
    const repoFolder = opts.repoFolder ?? resolveFolder(repoName);
    const repoBase = join(base, repoName);
    for (const channelId of safeReaddir(repoBase)) {
      const channelBase = join(repoBase, channelId);
      for (const threadTs of safeReaddir(channelBase)) {
        const dir = join(channelBase, threadTs);
        try {
          const marker = join(dir, MARKER_FILE);
          const mtime = existsSync(marker) ? statSync(marker).mtimeMs : statSync(dir).mtimeMs;
          if (mtime >= cutoff) continue;
          try {
            git(['worktree', 'remove', '--force', dir], repoFolder);
          } catch {
            // Not a registered worktree (or repo gone) — remove the dir below
          }
          try {
            git(['branch', '-D', `wt/${channelId}/${threadTs}`], repoFolder);
          } catch {
            // branch already gone
          }
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
          }
          console.log(`[worktrees] Pruned stale worktree ${repoName}/${channelId}/${threadTs}`);
        } catch {
          // skip unreadable entries
        }
      }
    }
  }
}

function safeReaddir(dir: string): string[] {
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
