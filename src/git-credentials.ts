import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { secretsDir } from './secrets.js';
import type { GitCredentialResolution } from './credentials.js';

/**
 * Git enforcement adapter (merged-plan decision #8): repos are cloned over SSH
 * but user/shared PATs are HTTPS-only, so each spawn gets a generated
 * GIT_CONFIG_GLOBAL file that rewrites SSH remotes to HTTPS and points
 * `credential.helper` at a tiny inline helper. The gitconfig itself never
 * contains a token literal; the helper reads a 0600 credential file under
 * `.secrets/git-credentials/` (gitignored, wiped at startup). Full
 * credential-helper indirection (no on-disk token at all) is Future #4.
 */

const GIT_CRED_SUBDIR = 'git-credentials';

export function gitCredentialsDir(baseDir?: string): string {
  return join(secretsDir(baseDir), GIT_CRED_SUBDIR);
}

function handleFor(cred: GitCredentialResolution): string {
  return createHash('sha256').update(`${cred.cacheKey}\n${cred.token}`).digest('hex').slice(0, 16);
}

/**
 * Materialize the per-identity gitconfig + credential file, reusing existing
 * files for the same identity+token (persistent processes keep their spawn
 * env, so paths must stay valid for the claudeway process lifetime).
 * Returns the path to pass as GIT_CONFIG_GLOBAL.
 */
export function ensureGitCredentialFiles(cred: GitCredentialResolution, baseDir?: string): string {
  const dir = gitCredentialsDir(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const handle = handleFor(cred);
  const credPath = join(dir, `${handle}.cred`);
  const gitconfigPath = join(dir, `${handle}.gitconfig`);

  if (!existsSync(credPath)) {
    writeFileSync(credPath, `username=${cred.username}\npassword=${cred.token}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    chmodSync(credPath, 0o600);
  }
  if (!existsSync(gitconfigPath)) {
    writeFileSync(gitconfigPath, buildGitConfig(credPath), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(gitconfigPath, 0o600);
  }
  return gitconfigPath;
}

/**
 * Build the gitconfig content: SSH→HTTPS rewrite + credential helper reference.
 * Contains NO token literal — the helper cats the 0600 credential file.
 */
export function buildGitConfig(credPath: string): string {
  if (credPath.includes("'")) {
    throw new Error(`git credential path must not contain single quotes: ${credPath}`);
  }
  return [
    '[url "https://github.com/"]',
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    // Scope the helper to github.com HTTPS only. An unscoped [credential] helper
    // answers `get` for ANY host, leaking the GitHub PAT to any other HTTPS
    // remote the agent contacts. The URL rewrite above already maps all github
    // remotes to https://github.com/, so this section covers every real case.
    '[credential "https://github.com"]',
    // Empty helper resets any inherited helper list before ours
    '\thelper = ',
    `\thelper = "!f() { test \\"$1\\" = get && cat '${credPath}'; :; }; f"`,
    '',
  ].join('\n');
}

/** Wipe stale credential/gitconfig files (called at startup). */
export function cleanupGitCredentialFiles(baseDir?: string): void {
  try {
    rmSync(gitCredentialsDir(baseDir), { recursive: true, force: true });
  } catch {
    // best effort
  }
}
