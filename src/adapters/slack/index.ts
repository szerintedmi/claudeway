import { App } from '@slack/bolt';
import { loadConfig } from '../../config.js';
import { registerMessageHandler, drainAllPending } from './handler.js';

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

/**
 * Returns a shutdown hook that notifies the bot owner.
 * Called by the shared lifecycle manager.
 */
export function getSlackShutdownHook(): (() => Promise<void>) | null {
  if (!slackApp) return null;
  return () => notifyOwner(slackApp, ':wave: Claudeway shutting down');
}

export async function startSlackAdapter(): Promise<App> {
  const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;

  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    throw new Error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN in env');
  }

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
    throw new Error('Could not resolve bot user ID from auth.test');
  }

  // Check if we have users:read scope (needed for mention resolution)
  let canResolveUsers = false;
  try {
    await app.client.users.info({ user: botUserId });
    canResolveUsers = true;
  } catch (err) {
    console.warn(
      '[startup] Cannot call users.info — missing users:read scope? Mentions will pass through as raw <@U...> IDs.',
      err instanceof Error ? err.message : err,
    );
  }

  registerMessageHandler(app, botUserId, canResolveUsers);

  const channelCount = Object.keys(config.channels).length;
  console.log('Slack adapter started');
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

  return app;
}
