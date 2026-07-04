import { resolve, sep } from 'path';

/**
 * Sanitize a single path component before it is joined into a filesystem path.
 * Collapses `..` (path traversal) before filtering to a safe character set.
 * Shared by worktree paths (`src/worktrees.ts`) and the per-session temp dir
 * layout (`src/tempdir.ts`, `src/adapters/slack/files.ts`).
 */
export function sanitize(part: string): string {
  // Collapse `..` (path traversal) before the character filter
  return part.replace(/\.\.+/g, '.').replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * True when `candidate` resolves to `base` itself or a path inside it. Used as
 * a defence-in-depth check before writing sender-supplied filenames so a crafted
 * name can't escape the intended directory.
 */
export function isInside(base: string, candidate: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + sep);
}
