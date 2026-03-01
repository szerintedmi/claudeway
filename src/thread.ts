import type { WebClient } from '@slack/web-api';
import { warnInThread } from './slack-utils.js';

export interface ThreadMessage {
  authorName: string;
  isBot: boolean;
  text: string;
}

const userNameCache = new Map<string, string>();

export function resetUserNameCache(): void {
  userNameCache.clear();
}

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const p = res.user?.profile as Record<string, string | undefined> | undefined;
    const name =
      p?.display_name_normalized ||
      p?.display_name ||
      p?.real_name_normalized ||
      p?.real_name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, userId);
    return userId;
  }
}

export async function fetchThreadContext(
  client: WebClient,
  channelId: string,
  threadTs: string,
  triggerTs: string,
  botUserId: string,
): Promise<ThreadMessage[]> {
  try {
    const allMessages: Array<{
      ts?: string;
      user?: string;
      bot_id?: string;
      text?: string;
      username?: string;
    }> = [];

    let cursor: string | undefined;
    do {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const messages = res.messages ?? [];
      allMessages.push(...messages);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    const prior = allMessages.filter((m) => m.ts !== triggerTs);
    if (prior.length === 0) return [];

    const resolved: ThreadMessage[] = [];
    for (const m of prior) {
      const isBot = !!m.bot_id || m.user === botUserId;
      const authorName = isBot ? 'Claude' : await resolveUserName(client, m.user ?? 'unknown');
      const text = (m.text ?? '').trim();
      if (!text) continue;
      resolved.push({ authorName, isBot, text });
    }
    return resolved;
  } catch (err) {
    console.error(
      '[thread] Failed to fetch thread context:',
      err instanceof Error ? err.message : err,
    );
    await warnInThread(
      client,
      channelId,
      threadTs,
      'Could not load thread history — responding without context.',
    );
    return [];
  }
}
