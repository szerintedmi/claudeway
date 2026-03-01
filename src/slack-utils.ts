import type { WebClient } from '@slack/web-api';

/**
 * Check if a user is allowed to use a channel.
 * Returns true if allowedUsers is not set or empty (open to everyone),
 * or if the user's Slack ID is in the list.
 */
export function isUserAllowed(allowedUsers: string[] | undefined, userId: string): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
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
