import type { WebClient } from '@slack/web-api';
import type { PromptCoordinator, SessionState } from '../../core/interfaces.js';
import type { QueuedMessage } from '../../queue.js';
import {
  loadSlackHistoryState,
  saveSlackHistoryState,
  compareSlackTs,
} from '../../slack-history.js';
import { fetchThreadEntries, type SlackThreadEntry } from './thread.js';
import { renderSlackPrompt } from './prompt.js';
import { downloadSlackFiles, type SlackFile } from './files.js';
import type { SlackFileMeta } from '../../queue.js';

/**
 * History selection (docs/plans/2026-07-04-slack-history-injection-rework.md):
 *
 * - Everything at/after the current message is excluded (later queued turns
 *   render their own context when their turn comes).
 * - Resuming: only messages after the watermark; Claudeway's own messages are
 *   excluded (the session transcript already has them). No watermark →
 *   conservative fallback: full prior thread once.
 * - New session (artifact-loss edge case): full prior thread INCLUDING own bot
 *   messages, labeled — the fresh transcript doesn't have them.
 */
export function selectContextEntries(
  entries: SlackThreadEntry[],
  opts: { resuming: boolean; watermark?: string; currentTs: string },
): SlackThreadEntry[] {
  return entries.filter((e) => {
    if (compareSlackTs(e.ts, opts.currentTs) >= 0) return false;
    if (opts.resuming && e.isSelfBot) return false;
    if (opts.resuming && opts.watermark && compareSlackTs(e.ts, opts.watermark) <= 0) return false;
    return true;
  });
}

/**
 * Download a batch of file metas into the session's incoming/ and return the
 * id→localPath map plus any non-fatal warnings. `origin` only differentiates the
 * warning wording so a stale/deleted context attachment doesn't read like the
 * user's fresh upload failed. Files without a download reference are skipped.
 */
async function downloadMetas(
  metas: SlackFileMeta[],
  token: string,
  sessionTempDir: string,
  origin: 'current' | 'context',
): Promise<{ pathsById: Map<string, string>; warnings: string[] }> {
  const downloadable: SlackFile[] = metas
    .filter((f) => f.downloadRef)
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.mimetype ?? '',
      size: f.size ?? 0,
      url_private_download: f.downloadRef,
    }));
  if (downloadable.length === 0) return { pathsById: new Map(), warnings: [] };

  const result = await downloadSlackFiles(downloadable, token, sessionTempDir);
  const warnings: string[] = [];
  const where = origin === 'current' ? '' : ' referenced in earlier messages';
  if (result.failedCount > 0) {
    warnings.push(
      `Failed to download ${result.failedCount} of ${result.totalCount} file(s)${where}. Check server logs.`,
    );
  }
  if (result.oversizedCount > 0) {
    warnings.push(
      `Skipped ${result.oversizedCount} file(s)${where} over the 25MB attachment limit.`,
    );
  }
  return { pathsById: result.pathsById, warnings };
}

/**
 * Rebuild metas with the resolved local path; drop the server-side downloadRef
 * so it can never leak into the rendered prompt.
 */
function applyLocalPaths(files: SlackFileMeta[], pathsById: Map<string, string>): SlackFileMeta[] {
  return files.map((f) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { downloadRef, ...rest } = f;
    const localPath = pathsById.get(f.id);
    return localPath ? { ...rest, localPath } : { ...rest };
  });
}

/**
 * Download the current message's files into the session's incoming/ and return
 * the render metas with `localPath` filled in (so the prompt's `path=` points at
 * the freshly downloaded file), plus any non-fatal warnings. Files without a
 * download reference (e.g. oversized ones represented for metadata only) pass
 * through without a local path.
 */
async function resolveCurrentFiles(
  files: SlackFileMeta[] | undefined,
  token: string,
  sessionTempDir: string,
): Promise<{ files?: SlackFileMeta[]; warnings: string[] }> {
  if (!files || files.length === 0) return { files, warnings: [] };
  const { pathsById, warnings } = await downloadMetas(files, token, sessionTempDir, 'current');
  return { files: applyLocalPaths(files, pathsById), warnings };
}

/**
 * Download files attached to prior thread messages (the ones rendered under
 * `--- Slack context ---`) into the same incoming/ dir, filling `localPath` on
 * each entry in place so they render with a `path=` just like current-message
 * files. This is what makes "user posted the file in one message, then @mentioned
 * the bot in the next" work — those attachments are context, not current, but
 * `conversations.replies` gives us their download URL. Volume is bounded by the
 * history window (resumed sessions only see messages past the watermark) and by
 * skip-if-exists in downloadSlackFiles, so a file downloads at most once.
 */
async function resolveContextFiles(
  context: SlackThreadEntry[],
  token: string,
  sessionTempDir: string,
): Promise<{ warnings: string[] }> {
  const metas = context.flatMap((e) => e.files ?? []);
  if (metas.length === 0) return { warnings: [] };
  const { pathsById, warnings } = await downloadMetas(metas, token, sessionTempDir, 'context');
  for (const e of context) {
    if (e.files && e.files.length > 0) e.files = applyLocalPaths(e.files, pathsById);
  }
  return { warnings };
}

export function makeSlackPromptCoordinator(
  client: WebClient,
  canResolveUsers = true,
): PromptCoordinator {
  return {
    async prepare(
      queued: QueuedMessage,
      session: SessionState,
      ctx: { sessionTempDir: string },
    ): Promise<{ text: string; warnings?: string[] }> {
      const slack = queued.slack;
      // Engine gates on queued.slack, but keep the legacy passthrough as a guard
      if (!slack) return { text: queued.text };

      // A stale watermark without a live transcript is meaningless — new
      // sessions always get the full prior thread.
      const watermark = session.resuming
        ? loadSlackHistoryState(session.sessionId)?.lastSeenSlackTs
        : undefined;

      // Thread-starting message: nothing prior can exist, skip the fetch
      const isThreadStart = queued.ts === queued.threadTs;
      let entries: SlackThreadEntry[] = [];
      if (!isThreadStart) {
        entries =
          (await fetchThreadEntries(client, queued.channelId, queued.threadTs, {
            // Bound the fetch server-side on resumed sessions
            ...(watermark ? { oldest: watermark } : {}),
            canResolveUsers,
            botUserId: slack.botUserId,
          })) ?? [];
      }

      const context = selectContextEntries(entries, {
        resuming: session.resuming,
        watermark,
        currentTs: queued.ts,
      });

      // Download attachments at processing time (D10), keyed by the resolved
      // session — so a folder/repo change while the message was queued lands the
      // files under the correct session's incoming/, not an orphaned enqueue-time
      // bucket. Both the current message's files and any attachments in the
      // injected context are fetched, so a file posted in one message and
      // referenced by a later @mention is still available on disk. Failures and
      // oversized files become warnings, not throws.
      const token = client.token ?? process.env.SLACK_BOT_TOKEN ?? '';
      const { files: currentFiles, warnings } = await resolveCurrentFiles(
        slack.files,
        token,
        ctx.sessionTempDir,
      );
      const { warnings: contextWarnings } = await resolveContextFiles(
        context,
        token,
        ctx.sessionTempDir,
      );

      const text = renderSlackPrompt({
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        newSession: !session.resuming,
        botUserId: slack.botUserId,
        botName: slack.botName,
        context,
        current: {
          ts: queued.ts,
          userId: slack.senderId,
          authorName: slack.senderName,
          text: slack.rawText,
          files: currentFiles,
        },
      });
      const allWarnings = [...warnings, ...contextWarnings];
      return allWarnings.length > 0 ? { text, warnings: allWarnings } : { text };
    },

    async onTurnCommitted(queued: QueuedMessage, session: SessionState): Promise<void> {
      saveSlackHistoryState({
        sessionId: session.sessionId,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        lastSeenSlackTs: queued.ts,
      });
    },
  };
}
