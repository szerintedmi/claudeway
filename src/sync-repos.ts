import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { loadConfig, resolveFolder } from './config.js';
import { resolveSharedGitCredential } from './credentials.js';
import { ensureGitCredentialFiles } from './git-credentials.js';

function run(args: string[], cwd: string | undefined, gitEnv: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    env: gitEnv,
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

  // Authenticate clones/pulls over HTTPS with the shared git PAT: the generated
  // gitconfig rewrites SSH remotes (git@github.com:) to HTTPS and points a
  // github.com-scoped credential helper at the token. When no shared token is
  // configured, git uses ambient config (SSH agent / public repos).
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const sharedGit = resolveSharedGitCredential(config);
  if (sharedGit) {
    gitEnv.GIT_CONFIG_GLOBAL = ensureGitCredentialFiles(sharedGit);
    console.log('[sync-repos] Using shared git PAT for HTTPS auth');
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
        run(
          ['clone', ...branchArgs, '--recurse-submodules', repo.url, repoPath],
          undefined,
          gitEnv,
        );
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
        const stashOutput = run(['stash'], repoPath, gitEnv);
        const hadStash = stashOutput.includes('Saved working directory');
        if (hadStash) {
          console.log(`[sync-repos] WARNING: ${name} had uncommitted changes (stashed)`);
        }

        run(['fetch', 'origin'], repoPath, gitEnv);

        if (repo.branch) {
          const currentBranch = run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, gitEnv);
          if (currentBranch !== repo.branch) {
            run(['checkout', repo.branch], repoPath, gitEnv);
          }
        }

        try {
          run(['pull', '--ff-only'], repoPath, gitEnv);
        } catch {
          console.log(
            `[sync-repos] WARNING: ${name} pull --ff-only failed (may need manual resolution)`,
          );
        }

        // --remote checks out the tip of each submodule's tracked branch (latest
        // main) rather than the SHA pinned by the parent — keep shared submodules
        // fresh for reading, not stuck at the parent's recorded commit.
        run(['submodule', 'update', '--remote', '--init', '--recursive'], repoPath, gitEnv);
        try {
          run(
            [
              'submodule',
              'foreach',
              '--recursive',
              'if test "$(git rev-parse --is-shallow-repository)" = true; then git fetch --unshallow; fi',
            ],
            repoPath,
            gitEnv,
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
