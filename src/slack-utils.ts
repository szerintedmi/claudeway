import type { WebClient } from '@slack/web-api';
import { extractAllowedUserIds, type AllowedUserEntry } from './config.js';

/**
 * Check if a user is allowed to use a channel.
 * Returns true if allowedUsers is not set or empty (open to everyone),
 * or if the user's Slack ID is in the list.
 * Supports both plain string entries and permission-mapped entries.
 */
export function isUserAllowed(
  allowedUsers: AllowedUserEntry[] | undefined,
  userId: string,
): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  return extractAllowedUserIds(allowedUsers).includes(userId);
}

/**
 * Post a warning to a Slack thread. Swallows errors — safe to call without disrupting the caller.
 */
export async function warnInThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  message: string,
): Promise<void> {
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:warning: ${message}`,
    });
  } catch {
    console.error(`[warn] Failed to post warning to thread: ${message}`);
  }
}

export async function safeReact(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
  action: 'add' | 'remove' = 'add',
): Promise<void> {
  try {
    if (action === 'add') {
      await client.reactions.add({ channel, timestamp, name });
    } else {
      await client.reactions.remove({ channel, timestamp, name });
    }
  } catch {
    // Ignore reaction errors
  }
}
