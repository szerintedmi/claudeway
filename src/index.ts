import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { loadConfig } from './config.js';
import { ensureQueueDir } from './queue.js';
import { syncRepos } from './sync-repos.js';
import { generateReadOnlyMcpConfig } from './mcp.js';
import { FILE_TEMP_BASE } from './adapters/slack/files.js';

// --- Shared startup utilities ---

function cleanupOldTempFiles(): void {
  if (!existsSync(FILE_TEMP_BASE)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const channelDir of readdirSync(FILE_TEMP_BASE)) {
      const channelPath = join(FILE_TEMP_BASE, channelDir);
      try {
        for (const name of readdirSync(channelPath)) {
          const filepath = join(channelPath, name);
          try {
            if (statSync(filepath).mtimeMs < cutoff) {
              unlinkSync(filepath);
              console.log(`[cleanup] Removed old temp file: ${channelDir}/${name}`);
            }
          } catch {
            // ignore per-file errors
          }
        }
      } catch {
        // not a directory or read failed, skip
      }
    }
  } catch {
    // base dir read failed, ignore
  }
}

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
cleanupOldTempFiles();
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
const config = loadConfig();
const glassesEnabled = config.glassesServer?.enabled;

if (!hasSlack && !glassesEnabled) {
  console.error('No adapters configured. Set Slack env vars or enable glassesServer in config.');
  process.exit(1);
}

if (hasSlack) {
  const { startSlackAdapter, getSlackShutdownHook } = await import('./adapters/slack/index.js');
  await startSlackAdapter();
  const hook = getSlackShutdownHook();
  if (hook) shutdownHooks.push(hook);
}

if (glassesEnabled) {
  const { startGlassesAdapter } = await import('./adapters/glasses/index.js');
  startGlassesAdapter(config);
}

console.log('Claudeway started');

// Heartbeat — log every 30 minutes so you can tell it's alive
setInterval(
  () => {
    console.log(`[heartbeat] ${new Date().toISOString()} — alive`);
  },
  30 * 60 * 1000,
);
