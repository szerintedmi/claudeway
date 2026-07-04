import type { WebClient } from '@slack/web-api';
import { extractTextFromAttachments, type SlackAttachment } from './attachments.js';
import { warnInThread } from './utils.js';
import type { SlackFileMeta } from '../../queue.js';

/** One Slack thread message with enough metadata to cite/select it. */
export interface SlackThreadEntry {
  ts: string;
  /** Slack user id when the author has one (humans and bot users). */
  userId?: string;
  /** Resolved display name; undefined when unresolvable (no users:read scope). */
  authorName?: string;
  /** Claudeway's own bot. */
  isSelfBot: boolean;
  /** Any bot author (self or third-party). */
  isBot: boolean;
  /** Message text with extractable attachment text merged; '' for file-only messages. */
  text: string;
  files?: SlackFileMeta[];
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
  } catch (err) {
    console.warn(
      `[thread] Failed to resolve user name for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    userNameCache.set(userId, userId);
    return userId;
  }
}

interface RawReplyMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  username?: string;
  attachments?: SlackAttachment[];
  files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
}

function collectFileMeta(m: RawReplyMessage): SlackFileMeta[] {
  const attachmentFiles = (m.attachments ?? []).flatMap((a) => a.files ?? []);
  return [...(m.files ?? []), ...attachmentFiles]
    .filter((f) => f.id && f.name)
    .map((f) => ({
      id: f.id!,
      name: f.name!,
      ...(f.mimetype ? { mimetype: f.mimetype } : {}),
      ...(f.size !== undefined ? { size: f.size } : {}),
    }));
}

/**
 * Fetch ALL messages of a Slack thread as structured entries — including the
 * triggering/current message and file-only messages. Selection (watermark
 * filtering, own-bot exclusion) is the coordinator's job.
 *
 * `oldest` bounds the fetch server-side (resumed sessions pass the watermark
 * so long threads don't re-download everything every turn).
 *
 * On API failure: warns in the thread and returns null so the caller can
 * render without context (mirrors the old fetchThreadContext behavior).
 */
export async function fetchThreadEntries(
  client: WebClient,
  channelId: string,
  threadTs: string,
  opts: { oldest?: string; canResolveUsers?: boolean; botUserId: string },
): Promise<SlackThreadEntry[] | null> {
  const canResolveUsers = opts.canResolveUsers ?? true;
  try {
    const allMessages: RawReplyMessage[] = [];

    let cursor: string | undefined;
    do {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const messages = res.messages ?? [];
      allMessages.push(...messages);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    const entries: SlackThreadEntry[] = [];
    for (const m of allMessages) {
      if (!m.ts) continue;
      // Only OUR bot's messages are Claude's own — keying on any `bot_id`
      // would mislabel third-party bots (GitHub/Jira/CI) as things "Claude
      // said", feeding the model false self-attributed context.
      const isSelfBot = !!m.user && m.user === opts.botUserId;
      const isBot = isSelfBot || !!m.bot_id;
      const attachmentText = extractTextFromAttachments(m.attachments);
      const text = [m.text, attachmentText].filter(Boolean).join('\n\n').trim();
      const files = collectFileMeta(m);
      // Nothing renderable at all — skip (file-only messages stay: they render
      // as prefix + attachment metadata line)
      if (!text && files.length === 0) continue;
      const authorName =
        canResolveUsers && m.user ? await resolveUserName(client, m.user) : m.username;
      entries.push({
        ts: m.ts,
        ...(m.user ? { userId: m.user } : {}),
        ...(authorName ? { authorName } : {}),
        isSelfBot,
        isBot,
        text,
        ...(files.length > 0 ? { files } : {}),
      });
    }
    return entries;
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
    return null;
  }
}
