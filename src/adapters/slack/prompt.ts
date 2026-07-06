import type { SlackFileMeta } from '../../queue.js';

/**
 * Prompt rendering for structured Slack turns (render-at-processing-time).
 * Pure formatting — history selection lives in the coordinator, Slack API
 * access in thread.ts.
 *
 * Shape (docs/plans/2026-07-04-slack-history-injection-rework.md):
 *
 *   === Slack thread id: C123/<threadTs> ; Bot (you): <@UBOT> Claudeway ===   (new session only)
 *
 *   --- Slack context ---                                                     (only when injecting)
 *   [<ts> <@U111> Alice]: message text
 *   {File attachment(s): name="..." id=F1 type=... size=... ref=slack-file:C123:<ts>:F1}
 *
 *   [<ts> <@U333> Cara]: message text                                         (current message; every turn)
 *   {File attachment(s): ... path=/local/path}                                (any downloaded file)
 *
 * The current message needs no id header: the channel id is in the new-session
 * thread header (and the resumed session transcript), and the message ts lives
 * in the `[<ts> <@U...> Name]:` prefix. It is always the final block.
 */
export interface SlackPromptEntry {
  ts: string;
  /** Slack user id when the author has one (humans and bot users). */
  userId?: string;
  authorName?: string;
  /** Claudeway's own bot — rendered with a "(you)" label. */
  isSelfBot?: boolean;
  /** Any bot author; third-party bots get a "(bot)" label. */
  isBot?: boolean;
  text: string;
  files?: SlackFileMeta[];
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Stable per-file citation handle (channel:ts:fileId) — never a Slack URL. */
export function slackFileRef(channelId: string, messageTs: string, fileId: string): string {
  return `slack-file:${channelId}:${messageTs}:${fileId}`;
}

/**
 * `{File attachment(s): ...}` line for one message. Curly braces keep it
 * visually distinct from the square-bracket message prefixes; multiple files
 * are separated by ` ; ` so each scans as a distinct item. `path=` appears for
 * any downloaded file (current message or injected context); a file with no
 * download URL renders ref-only.
 */
export function formatFileMetaLine(
  channelId: string,
  messageTs: string,
  files: SlackFileMeta[],
): string {
  const items = files.map((f) => {
    const parts = [
      `name="${f.name}"`,
      `id=${f.id}`,
      ...(f.mimetype ? [`type=${f.mimetype}`] : []),
      `size=${formatFileSize(f.size)}`,
      `ref=${slackFileRef(channelId, messageTs, f.id)}`,
      ...(f.localPath ? [`path=${f.localPath}`] : []),
    ];
    return parts.join(' ');
  });
  return `{File attachment(s): ${items.join(' ; ')}}`;
}

/**
 * Message prefix carrying ts + author identity so Claude can cite exact
 * messages and use `<@U...>` mentions in replies:
 *   [<ts> <@U111> Alice]      — human with resolved name
 *   [<ts> <@U111>]            — name unresolvable (missing users:read scope)
 *   [<ts> <@UBOT> Bot (you)]  — Claudeway itself (new-session injection only)
 *   [<ts> Jira (bot)]         — third-party bot without a user id
 */
export function formatEntryPrefix(entry: SlackPromptEntry): string {
  const label = entry.isSelfBot ? ' (you)' : entry.isBot ? ' (bot)' : '';
  const author = [entry.userId ? `<@${entry.userId}>` : undefined, entry.authorName]
    .filter(Boolean)
    .join(' ');
  return `[${[entry.ts, author].filter(Boolean).join(' ')}${label}]`;
}

/** One message rendered as prefix line + optional attachment metadata line. */
export function formatEntry(channelId: string, entry: SlackPromptEntry): string {
  const lines = [`${formatEntryPrefix(entry)}: ${entry.text}`.trimEnd()];
  if (entry.files && entry.files.length > 0) {
    lines.push(formatFileMetaLine(channelId, entry.ts, entry.files));
  }
  return lines.join('\n');
}

export interface RenderSlackPromptOpts {
  channelId: string;
  threadTs: string;
  /** True when this turn starts a fresh Claude session — emits the thread header. */
  newSession: boolean;
  botUserId: string;
  botName?: string;
  /** Prior messages to inject (already selected by the coordinator). */
  context: SlackPromptEntry[];
  current: SlackPromptEntry;
}

export function renderSlackPrompt(opts: RenderSlackPromptOpts): string {
  const sections: string[] = [];

  if (opts.newSession) {
    const bot = [`<@${opts.botUserId}>`, opts.botName].filter(Boolean).join(' ');
    sections.push(
      `=== Slack thread id: ${opts.channelId}/${opts.threadTs} ; Bot (you): ${bot} ===`,
    );
  }

  if (opts.context.length > 0) {
    sections.push(
      ['--- Slack context ---', ...opts.context.map((e) => formatEntry(opts.channelId, e))].join(
        '\n',
      ),
    );
  }

  sections.push(formatEntry(opts.channelId, opts.current));

  return sections.join('\n\n');
}
