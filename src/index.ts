import { writeFileSync, readFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { loadConfig, resolvedTempDir, DEFAULT_TEMP_MAX_AGE_DAYS } from './config.js';
import { ensureQueueDir } from './queue.js';
import { syncRepos } from './sync-repos.js';
import { generateReadOnlyMcpConfig } from './mcp.js';
import { FILE_TEMP_BASE } from './adapters/slack/files.js';
import { cleanupStaleTempFiles } from './tempdir.js';

// --- Shared startup utilities ---

const PIDFILE = resolve(process.cwd(), 'claudeway.pid');

function acquireLock(): void {
  if (existsSync(PIDFILE)) {
    const oldPid = parseInt(readFileSync(PIDFILE, 'utf-8').trim(), 10);
    try {
      process.kill(oldPid, 0);
      console.error(`Another Claudeway instance is running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      console.log(`Removing stale pidfile (PID ${oldPid})`);
    }
  }
  writeFileSync(PIDFILE, String(process.pid), 'utf-8');
}

function releaseLock(): void {
  try {
    unlinkSync(PIDFILE);
  } catch {
    // ignore
  }
}

function killOrphanProcesses(): void {
  try {
    execSync('pkill -9 -f "claude.*dangerously-skip-permissions" 2>/dev/null', {
      stdio: 'ignore',
    });
  } catch {
    // No orphans found, that's fine
  }
}

// --- Shutdown ---

// Adapter shutdown hooks — called in order before exit
const shutdownHooks: (() => Promise<void>)[] = [];

function shutdown(): void {
  console.log('Claudeway shutting down');
  Promise.allSettled(shutdownHooks.map((fn) => fn())).finally(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  });
  // Force exit after 3s if hooks hang
  setTimeout(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  }, 3000);
}

// --- Shared startup sequence ---

acquireLock();
killOrphanProcesses();

const config = loadConfig();
const tempMaxAgeDays = config.defaults.tempMaxAgeDays ?? DEFAULT_TEMP_MAX_AGE_DAYS;
cleanupStaleTempFiles(tempMaxAgeDays, resolvedTempDir(config), FILE_TEMP_BASE);

process.on('exit', releaseLock);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

ensureQueueDir();
syncRepos();

// Generate read-only MCP config if mcp.json exists
const mcpPath = resolve(process.cwd(), 'mcp.json');
if (existsSync(mcpPath) && statSync(mcpPath).isFile()) {
  try {
    generateReadOnlyMcpConfig(mcpPath);
    console.log('[startup] Generated mcp-readonly.json');
  } catch (err) {
    console.warn(
      '[startup] Failed to generate mcp-readonly.json:',
      err instanceof Error ? err.message : err,
    );
  }
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

console.log('Claudeway started');

// Heartbeat — log every 30 minutes so you can tell it's alive
setInterval(
  () => {
    console.log(`[heartbeat] ${new Date().toISOString()} — alive`);
  },
  30 * 60 * 1000,
);
