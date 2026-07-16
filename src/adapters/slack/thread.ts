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

/**
 * Slack user-mention token inside message text: `<@U123>` or `<@W123>` (enterprise
 * grid) with an optional `|fallback` label. Bot-user mentions use the same shape.
 */
const BODY_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Rewrite in-body `<@U...>` mentions to a standard `<@U...> (Name)` form so the
 * model always sees who an ID refers to. The author of each message is
 * name-resolved separately (`formatEntryPrefix`); this covers mentions *inside*
 * the message text — people addressed, cc'd, or quoted in the body. Without it a
 * bare id carries no name and the model may invent a plaintext name for it.
 *
 * The real `<@U...>` token is preserved (so the model can echo it back as a live
 * mention). Unresolvable ids degrade to the bare token, unchanged. Any existing
 * `|fallback` label is normalized away. No-op when users:read scope is missing.
 */
export async function annotateBodyMentions(
  client: WebClient,
  text: string,
  canResolveUsers = true,
): Promise<string> {
  if (!canResolveUsers || !text) return text;
  const ids = new Set<string>();
  for (const m of text.matchAll(BODY_MENTION_RE)) ids.add(m[1]);
  if (ids.size === 0) return text;
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, await resolveUserName(client, id));
  return text.replace(BODY_MENTION_RE, (_whole, id: string) => {
    const name = names.get(id);
    return name && name !== id ? `<@${id}> (${name})` : `<@${id}>`;
  });
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
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
  }>;
}

/**
 * `conversations.replies` returns full file objects, so context (prior-message)
 * files carry `url_private_download` just like current-message files do. We
 * preserve it as `downloadRef` so the coordinator can fetch context attachments
 * into `incoming/` at processing time. It stays SERVER-SIDE (never rendered):
 * the prompt formatter reads only name/id/size/localPath, and the coordinator
 * strips `downloadRef` before render. Files without a download URL (some
 * external/hosted types) degrade to ref-only, exactly as before.
 */
function collectFileMeta(m: RawReplyMessage): SlackFileMeta[] {
  const attachmentFiles = (m.attachments ?? []).flatMap((a) => a.files ?? []);
  return [...(m.files ?? []), ...attachmentFiles]
    .filter((f) => f.id && f.name)
    .map((f) => ({
      id: f.id!,
      name: f.name!,
      ...(f.mimetype ? { mimetype: f.mimetype } : {}),
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.url_private_download ? { downloadRef: f.url_private_download } : {}),
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
      const rawText = [m.text, attachmentText].filter(Boolean).join('\n\n').trim();
      const text = await annotateBodyMentions(client, rawText, canResolveUsers);
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
