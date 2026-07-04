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

export function makeSlackPromptCoordinator(
  client: WebClient,
  canResolveUsers = true,
): PromptCoordinator {
  return {
    async prepare(queued: QueuedMessage, session: SessionState): Promise<{ text: string }> {
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
          files: slack.files,
        },
      });
      return { text };
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
