import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { loadConfig, resolveFolder } from './config.js';

function run(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    // Fail fast instead of hanging to the 120s timeout when a repo needs auth
    // (revoked token / private repo) — a blocked credential prompt would
    // otherwise stall the whole startup.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
    .toString()
    .trim();
}

export function syncRepos(): void {
  const config = loadConfig();
  if (!config.repos) {
    console.log('[sync-repos] No repos defined, skipping');
    return;
  }

  for (const [name, repo] of Object.entries(config.repos)) {
    const repoPath = resolveFolder(name);
    const gitDir = join(repoPath, '.git');

    if (!existsSync(gitDir)) {
      // Clone — wrapped like the update path so a bad URL / revoked auth / bad
      // branch on one repo logs and moves on instead of crashing the whole
      // process before any adapter starts.
      try {
        mkdirSync(repoPath, { recursive: true });
        console.log(`[sync-repos] Cloning ${name} from ${repo.url}`);
        const branchArgs = repo.branch ? ['--branch', repo.branch] : [];
        run(['clone', ...branchArgs, '--recurse-submodules', repo.url, repoPath]);
      } catch (err) {
        console.error(
          `[sync-repos] Failed to clone ${name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      // Update
      console.log(`[sync-repos] Updating ${name}`);
      try {
        const stashOutput = run(['stash'], repoPath);
        const hadStash = stashOutput.includes('Saved working directory');
        if (hadStash) {
          console.log(`[sync-repos] WARNING: ${name} had uncommitted changes (stashed)`);
        }

        run(['fetch', 'origin'], repoPath);

        if (repo.branch) {
          const currentBranch = run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
          if (currentBranch !== repo.branch) {
            run(['checkout', repo.branch], repoPath);
          }
        }

        try {
          run(['pull', '--ff-only'], repoPath);
        } catch {
          console.log(
            `[sync-repos] WARNING: ${name} pull --ff-only failed (may need manual resolution)`,
          );
        }

        run(['submodule', 'update', '--init', '--recursive'], repoPath);
        try {
          run(
            [
              'submodule',
              'foreach',
              '--recursive',
              'if test "$(git rev-parse --is-shallow-repository)" = true; then git fetch --unshallow; fi',
            ],
            repoPath,
          );
        } catch {
          console.log(
            `[sync-repos] WARNING: ${name} submodule unshallow failed (history may be partial)`,
          );
        }

        if (hadStash) {
          console.log(
            `[sync-repos] WARNING: ${name} has stashed changes — run 'git stash pop' to restore`,
          );
        }
      } catch (err) {
        console.error(
          `[sync-repos] Failed to update ${name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  console.log('[sync-repos] Repo sync complete');
}
