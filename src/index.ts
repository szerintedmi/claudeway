import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { registerMessageHandler, drainAllPending, FILE_TEMP_BASE } from './slack.js';
import { ensureQueueDir } from './queue.js';
import { syncRepos } from './sync-repos.js';

// Clean up temp files older than 24 hours from per-channel download directories
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

// Pidfile lock — ensure only one gateway runs at a time
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
  // Kill any claude -p processes and their child processes from previous runs
  try {
    execSync('pkill -9 -f "claude.*dangerously-skip-permissions" 2>/dev/null', {
      stdio: 'ignore',
    });
  } catch {
    // No orphans found, that's fine
  }
}

let ownerDmChannelId: string | null = null;

async function notifyOwner(app: App | null, message: string): Promise<void> {
  if (!app) return;
  try {
    const config = loadConfig();
    if (!config.botOwner) return;
    if (!ownerDmChannelId) {
      const result = await app.client.conversations.open({ users: config.botOwner });
      ownerDmChannelId = result.channel?.id ?? null;
      if (!ownerDmChannelId) return;
    }
    await app.client.chat.postMessage({
      channel: ownerDmChannelId,
      text: message,
    });
  } catch (err) {
    console.error('notifyOwner failed:', err instanceof Error ? err.message : err);
    if (err && typeof err === 'object' && 'data' in err) {
      console.error(
        'API response:',
        JSON.stringify((err as Record<string, unknown>).data, null, 2),
      );
    }
  }
}

let slackApp: App | null = null;

function shutdown(): void {
  console.log('Claudeway shutting down');
  // Fire-and-forget shutdown notification, then exit after brief delay
  notifyOwner(slackApp, ':wave: Claudeway shutting down').finally(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  });
  // Force exit after 3s if notification hangs
  setTimeout(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  }, 3000);
}

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

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN in .env');
  process.exit(1);
}

ensureQueueDir();
syncRepos();
const config = loadConfig();

const app = new App({
  token: SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: SLACK_APP_TOKEN,
});
slackApp = app;

app.error(async (error) => {
  console.error('Bolt error:', error);
});

await app.start();

const authResult = await app.client.auth.test();
const botUserId = authResult.user_id;
if (!botUserId) {
  console.error('Could not resolve bot user ID from auth.test — exiting');
  process.exit(1);
}

registerMessageHandler(app, botUserId);

const channelCount = Object.keys(config.channels).length;
console.log('Claudeway started');
console.log('Configured channels:');
for (const [id, ch] of Object.entries(config.channels)) {
  console.log(`  #${ch.name} (${id}) -> ${ch.repo ?? ch.folder ?? '.'}`);
}

await notifyOwner(
  app,
  `:rocket: Claudeway started. ${channelCount} channel${channelCount === 1 ? '' : 's'} configured. \`!config\` to list.`,
);

// Drain any messages left in queue from before restart
drainAllPending(app);

// Heartbeat — log every 30 minutes so you can tell it's alive
setInterval(
  () => {
    console.log(`[heartbeat] ${new Date().toISOString()} — alive`);
  },
  30 * 60 * 1000,
);
