// Subprocess environment construction (allowlist) + git enforcement + the
// persistent-process identity key. Split out of claude.ts so the env-allowlist
// job stands alone. `ClaudeOptions` is imported type-only, so there is no
// runtime cycle with claude.ts.

import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { permissionKey as permissionKeyStr, type Config, type UserPermissions } from './config.js';
import { gitCredConfigured } from './credentials.js';
import { ensureGitCredentialFiles } from './git-credentials.js';
import { scrubSecrets } from './secrets.js';
import { toolTmpDir } from './tempdir.js';
import type { ClaudeOptions } from './claude.js';

/**
 * Repo `scripts/` directory, resolved relative to this module. Prepended to the
 * subprocess PATH so the bare `claudeway-attach` command resolves in every run
 * mode — `bun src/index.ts` locally as well as Docker (where it's also
 * symlinked into /usr/local/bin). Without this, a local run fails the first
 * attach attempt with exit 127 ("command not found"). Module lives at
 * <root>/src/claude-spawn-env.ts, so scripts/ is one level up.
 */
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** Env vars that disable all git authentication — hard enforcement for read-only users. */
function buildGitReadOnlyEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: '/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    SSH_AUTH_SOCK: '',
    SSH_AGENT_PID: '',
  };
}

// TODO: Parameterize email domain when adding non-Slack adapters (currently hardcoded .slack)
/** Env vars that set git author/committer identity from user profile. */
function buildGitAuthorEnv(userName: string, channelName: string): Record<string, string> {
  const email = `${userName.toLowerCase().replace(/\s+/g, '.')}@${channelName}.slack`;
  return {
    GIT_AUTHOR_NAME: userName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: userName,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Git enforcement env (merged-plan decisions #7/#8).
 * - Resolved git token (personal or explicit shared default): per-spawn
 *   gitconfig with SSH→HTTPS rewrite + credential helper. The token never
 *   enters the subprocess env.
 * - Adapter configured but no token resolved: hard block git authentication.
 * - Adapter not configured: leave ambient git behavior unchanged.
 */
function buildGitEnv(options: ClaudeOptions): Record<string, string> {
  const gitCred = options.credentials?.git ?? null;
  if (gitCred) {
    const gitconfigPath = ensureGitCredentialFiles(gitCred);
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      GIT_SSH_COMMAND: '/bin/false', // force HTTPS — the gitconfig rewrites SSH remotes
      GIT_CONFIG_GLOBAL: gitconfigPath,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      SSH_AUTH_SOCK: '',
      SSH_AGENT_PID: '',
    };
  }

  if (gitCredConfigured(options.config)) return buildGitReadOnlyEnv();
  return {};
}

/** Build all permission-related env vars for a Claude subprocess. */
function buildPermissionsEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // Git author identity for all users with a resolved name
  if (options.userName && options.channelName) {
    Object.assign(env, buildGitAuthorEnv(options.userName, options.channelName));
  }

  Object.assign(env, buildGitEnv(options));

  return env;
}

/** Scrub resolved secret values from text before it is logged or surfaced. */
export function scrub(text: string, secretValues: readonly string[] | undefined): string {
  return secretValues && secretValues.length > 0 ? scrubSecrets(text, secretValues) : text;
}

/** Env vars always passed through to Claude subprocess (safe, non-secret). */
const BASELINE_ENV_VARS = new Set([
  'HOME',
  'USER',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'NODE_PATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

interface AllowedEnvContext {
  config: Config;
  userPermissions: UserPermissions;
  /** Explicitly injected vars (git author, git read-only, session temp dir + TMPDIR) */
  extraEnv?: Record<string, string>;
  /** Per-user credential env (personal or explicit shared default) — highest precedence. */
  userCredEnv?: Record<string, string>;
}

/**
 * Build the complete env for a Claude subprocess using an allowlist approach.
 * Only baseline vars + global env + permission-linked env + injected vars +
 * per-user credential env are included.
 */
export function buildAllowedEnv(ctx: AllowedEnvContext): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Baseline vars from process.env
  for (const key of BASELINE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // 2. Global env vars
  for (const varName of ctx.config.env ?? []) {
    if (process.env[varName]) env[varName] = process.env[varName]!;
  }

  // 3. Permission-linked env vars
  for (const permName of ctx.userPermissions) {
    for (const varName of ctx.config.permissions?.[permName]?.env ?? []) {
      if (process.env[varName]) env[varName] = process.env[varName]!;
    }
  }

  // 4. Explicit injected vars (git author, git read-only enforcement, CLAUDEWAY_* spawn vars)
  if (ctx.extraEnv) Object.assign(env, ctx.extraEnv);

  // 5. Per-user credentials — highest precedence (user secret > explicit shared default > unset)
  if (ctx.userCredEnv) Object.assign(env, ctx.userCredEnv);

  // 6. HOME fallback — use the server's own HOME (os.homedir()), not a
  // hardcoded /Users/<user> which is wrong on Linux/Docker.
  if (!env.HOME) env.HOME = process.env.HOME ?? homedir();

  return env;
}

/**
 * Compute the resolved env var names that would be exposed to Claude,
 * without including secret values. Used for restart key comparison.
 */
function resolveExposedEnvVarNames(config: Config, permissions: UserPermissions): string[] {
  const vars = new Set<string>();

  // Global env
  for (const v of config.env ?? []) vars.add(v);

  // Permission-linked env
  for (const permName of permissions) {
    for (const v of config.permissions?.[permName]?.env ?? []) vars.add(v);
  }

  return [...vars].sort();
}

/**
 * Compute a composite identity key for persistent process restart comparison.
 * Includes user identity, permissions, resolved env var names, a hash of the
 * user's resolved secret VALUES (never the values themselves), and the set of
 * MCP servers forced read-only — so a token change or read-only/full MCP
 * switch mid-thread triggers the existing kill/respawn path.
 */
export function processIdentityKey(
  userId: string,
  permissions: UserPermissions,
  config: Config,
  model: string,
  effort: string,
  secretsHash = '',
  readOnlyMcpServers: string[] = [],
): string {
  const permPart = permissionKeyStr(permissions);
  const envPart = resolveExposedEnvVarNames(config, permissions).join(',');
  return `${userId}|${permPart}|${envPart}|${model}|${effort}|${secretsHash}|${readOnlyMcpServers.join(',')}`;
}

/**
 * Build injected env vars (temp dirs, permissions) — these go through extraEnv,
 * not from process.env passthrough.
 */
export function buildInjectedEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // Put the repo scripts/ dir on PATH so `claudeway-attach` resolves regardless
  // of run mode. extraEnv is applied after the baseline PATH passthrough in
  // buildAllowedEnv, so read process.env.PATH here and prepend (don't clobber).
  const basePath = process.env.PATH;
  env.PATH = basePath ? `${SCRIPTS_DIR}:${basePath}` : SCRIPTS_DIR;

  if (options.tempDir) {
    // One env var for the session temp dir; TMPDIR points at its tmp/ subfolder
    // (D8) so generic tool temp (mktemp, python tempfile, …) lands inside the
    // managed tree instead of leaking to /tmp. TMPDIR is in BASELINE_ENV_VARS,
    // but step 4 of buildAllowedEnv (Object.assign of extraEnv) overrides it.
    env.CLAUDEWAY_TEMP_DIR = options.tempDir;
    env.TMPDIR = toolTmpDir(options.tempDir);
    env.CLAUDEWAY_CHANNEL_ID = options.channelId;
  }

  Object.assign(env, buildPermissionsEnv(options));

  return env;
}

/**
 * Build the complete env for a Claude subprocess using the allowlist approach.
 * Only baseline vars + configured secret groups + explicit injected vars are included.
 */
export function buildSpawnEnv(options: ClaudeOptions): Record<string, string> {
  return buildAllowedEnv({
    config: options.config,
    userPermissions: options.userPermissions,
    extraEnv: buildInjectedEnv(options),
    userCredEnv: options.credentials?.env,
  });
}
