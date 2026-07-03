import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { loadConfig, resolveFolder } from './config.js';

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 })
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
      // Clone
      mkdirSync(repoPath, { recursive: true });
      console.log(`[sync-repos] Cloning ${name} from ${repo.url}`);
      const branchArg = repo.branch ? `--branch ${repo.branch}` : '';
      run(`git clone ${branchArg} --recurse-submodules ${repo.url} ${repoPath}`);
    } else {
      // Update
      console.log(`[sync-repos] Updating ${name}`);
      try {
        const stashOutput = run('git stash', repoPath);
        const hadStash = stashOutput.includes('Saved working directory');
        if (hadStash) {
          console.log(`[sync-repos] WARNING: ${name} had uncommitted changes (stashed)`);
        }

        run('git fetch origin', repoPath);

        if (repo.branch) {
          const currentBranch = run('git rev-parse --abbrev-ref HEAD', repoPath);
          if (currentBranch !== repo.branch) {
            run(`git checkout ${repo.branch}`, repoPath);
          }
        }

        try {
          run('git pull --ff-only', repoPath);
        } catch {
          console.log(
            `[sync-repos] WARNING: ${name} pull --ff-only failed (may need manual resolution)`,
          );
        }

        run('git submodule update --init --recursive', repoPath);
        try {
          run(
            `git submodule foreach --recursive 'if test "$(git rev-parse --is-shallow-repository)" = true; then git fetch --unshallow; fi'`,
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
