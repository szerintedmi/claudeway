import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { reapOrphanedChildren, terminateOwnedChildren } from './child-processes.js';
import { loadConfig, resolvedTempDir, DEFAULT_TEMP_MAX_AGE_DAYS } from './config.js';
import { ensureQueueDir } from './queue.js';
import { syncRepos } from './sync-repos.js';
import { FILE_TEMP_BASE } from './adapters/slack/files.js';
import { cleanupStaleTempFiles } from './tempdir.js';
import { cleanupGitCredentialFiles } from './git-credentials.js';
import { cleanupStaleWorktrees } from './worktrees.js';
import { getSecretStore } from './secrets.js';

// --- Shared startup utilities ---

const PIDFILE = resolve(process.cwd(), 'claudeway.pid');

function acquireLock(): void {
  // Atomic create-or-fail: only one racing launch can win the `wx` create, so
  // two simultaneous starts can't both believe they hold the lock (the old
  // existsSync→kill→writeFile sequence had that TOCTOU window).
  for (;;) {
    try {
      writeFileSync(PIDFILE, String(process.pid), { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const oldPid = parseInt(readFileSync(PIDFILE, 'utf-8').trim(), 10);
      if (Number.isInteger(oldPid) && oldPid > 0) {
        try {
          process.kill(oldPid, 0);
          console.error(`Another Claudeway instance is running (PID ${oldPid}). Exiting.`);
          process.exit(1);
        } catch {
          // Recorded process is gone — stale pidfile, remove and retry the create.
        }
      }
      console.log(`Removing stale pidfile (PID ${oldPid})`);
      try {
        unlinkSync(PIDFILE);
      } catch {
        // A concurrent launcher may have removed it first — loop and retry the
        // `wx` create, which will now either succeed or lose to the winner.
      }
    }
  }
}

function releaseLock(): void {
  try {
    unlinkSync(PIDFILE);
  } catch {
    // ignore
  }
}

// --- Shutdown ---

// Adapter shutdown hooks — called in order before exit
const shutdownHooks: (() => Promise<void>)[] = [];

let shuttingDown = false;

/**
 * Graceful shutdown: run adapter hooks, then SIGTERM→grace→SIGKILL only the
 * Claude children this instance owns (never a host-wide kill), then release the
 * lock and exit. `code` is non-zero for a fatal-error shutdown.
 */
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Claudeway shutting down${code ? ' (fatal error)' : ''}`);
  const finish = () => {
    releaseLock();
    process.exit(code);
  };
  Promise.allSettled(shutdownHooks.map((fn) => fn()))
    .then(() => terminateOwnedChildren())
    .finally(finish);
  // Backstop: if hooks or child termination hang, force the exit.
  setTimeout(finish, 8000).unref?.();
}

// --- Shared startup sequence ---

acquireLock();

// Install cleanup + signal handlers immediately, before any fallible startup
// work below — otherwise a throw during the secrets/config checks would leak
// the pidfile (these used to be registered only after those checks).
process.on('exit', releaseLock);
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Fatal-error policy: an uncaught exception or rejection leaves the process in
// an unknown state — log it and shut down cleanly with a non-zero code rather
// than limp on with a possibly-corrupt process.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown(1);
});

// Reap Claude children orphaned by a previously crashed instance — scoped to
// the PIDs this cwd recorded, never a host-wide pattern kill.
reapOrphanedChildren();

const config = loadConfig();
const tempMaxAgeDays = config.defaults.tempMaxAgeDays ?? DEFAULT_TEMP_MAX_AGE_DAYS;
cleanupStaleTempFiles(tempMaxAgeDays, resolvedTempDir(config), FILE_TEMP_BASE);

// Per-user credentials are always on (BYO Claude): a master key and a
// reachable enrollment form are hard startup requirements — fail fast instead
// of limping along in a half-configured state.
cleanupGitCredentialFiles();
getSecretStore(); // throws without CLAUDEWAY_SECRETS_KEY / .secrets/key
if (!config.baseUrl) {
  throw new Error(
    'config.yaml: "baseUrl" is required — users enroll their Claude token via the !creds form ' +
      '(e.g. baseUrl: "http://192.168.1.10:8791")',
  );
}

ensureQueueDir();
syncRepos();

// Prune per-thread worktrees idle past threadWorktreeMaxAgeDays
try {
  cleanupStaleWorktrees(config);
} catch (err) {
  console.warn('[startup] Worktree cleanup failed:', err instanceof Error ? err.message : err);
}

// --- Conditional adapter boot ---

const hasSlack = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
const voiceEnabled = config.voiceServer?.enabled;

if (!hasSlack && !voiceEnabled) {
  console.error('No adapters configured. Set Slack env vars or enable voiceServer in config.');
  process.exit(1);
}

if (hasSlack) {
  const { startSlackAdapter, getSlackShutdownHook } = await import('./adapters/slack/index.js');
  await startSlackAdapter();
  const hook = getSlackShutdownHook();
  if (hook) shutdownHooks.push(hook);
}

if (voiceEnabled) {
  const { startVoiceAdapter } = await import('./adapters/voice/index.js');
  startVoiceAdapter(config);
}

// Enrollment form always runs — it is the only way to connect credentials
const { startCredsServer } = await import('./adapters/creds/index.js');
startCredsServer(config);

console.log('Claudeway started');

// Heartbeat — log every 30 minutes so you can tell it's alive
setInterval(
  () => {
    console.log(`[heartbeat] ${new Date().toISOString()} — alive`);
  },
  30 * 60 * 1000,
);
