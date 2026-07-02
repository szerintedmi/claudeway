export const MAX_MESSAGE_LENGTH = 3900;
export const FILE_THRESHOLD = 12000;

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Claude Code outputs standard Markdown by default; this ensures it renders
 * correctly in Slack even if the system prompt hint is ignored.
 *
 * Code blocks are extracted first and only have their language tag stripped —
 * all other conversions run only on non-code segments.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Split on fenced code blocks so conversions don't mangle code content.
  const parts: string[] = [];
  const codeBlockRe = /```\w*\n[\s\S]*?```/g;
  let lastIndex = 0;

  for (const match of text.matchAll(codeBlockRe)) {
    if (match.index > lastIndex) {
      parts.push(convertMarkdownText(text.slice(lastIndex, match.index)));
    }
    // Code blocks: only strip language tag, leave content untouched
    parts.push(match[0].replace(/^```\w+\n/, '```\n'));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(convertMarkdownText(text.slice(lastIndex)));
  }

  return parts.join('');
}

/**
 * Apply Markdown-to-mrkdwn conversions to a non-code-block text segment.
 */
function convertMarkdownText(text: string): string {
  let result = text;

  // Escape & and < before creating Slack tokens so Claude's literal text
  // (e.g. "x < y" or "AT&T") isn't misparsed by Slack as tokens/entities.
  // Link conversion below intentionally introduces < chars for Slack link tokens.
  result = result.replace(/&/g, '&amp;');
  // Escape `<` EXCEPT where it opens a valid Slack entity token, which Claude is
  // instructed to emit directly: links (<https://…|label>), user mentions
  // (<@U123>), channel refs (<#C123|name>), and specials (<!here>, <!subteam^…>).
  // Escaping those would turn them into literal `&lt;…>` text in Slack.
  result = result.replace(/<(?![@#!]|https?:\/\/|mailto:|tel:)/g, '&lt;');

  // Convert Markdown links [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headings (### text → *text*) — Slack has no heading syntax
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert **bold** → *bold* (must come before single-asterisk handling)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules (---, ***, ___) → ———
  result = result.replace(/^(?:[-*_]){3,}\s*$/gm, '———');

  // Convert Markdown bullet points (- item / * item) → • item
  result = result.replace(/^[*-] (.+)$/gm, '• $1');

  return result;
}

const STREAM_UPDATE_INTERVAL_MS = 500;
const STREAMING_INDICATOR = ' :writing_hand:';

/**
 * Emoji name (no colons) added as a reaction on the bot's live streamed message
 * (the work log when present, else the answer) while it streams and removed when
 * the stream finishes — a playful "generating" indicator. Best-effort: if the
 * workspace lacks this custom emoji the reaction silently no-ops.
 */
const ANSWER_STREAMING_REACTION = 'partyparrot';

/**
 * Native streaming (`chat.startStream`/`appendStream`/`stopStream`) tunables.
 *
 * The responder drives these methods directly and batches on a timer: text
 * accumulated since the last flush is sent at most once per interval. This
 * surfaces short finished responses within one interval while bounding the
 * per-stream call rate.
 *
 * 700ms ≈ 86 appends/min for a single stream, just under the shared budget
 * below so a lone stream flows without throttling.
 */
const STREAM_NATIVE_FLUSH_INTERVAL_MS = 700;

/**
 * Shared appendStream budget across ALL active streams. appendStream is Slack
 * Tier 4 (100+/min) and the limit is per-token, not per-message — so with up to
 * MAX_CONCURRENT_PROCESSES (8) streams running at once their appends must share
 * one budget. A module-level token bucket (see responder.ts) caps the aggregate
 * sustained rate to this value (with a small burst), keeping us under Tier 4 no
 * matter how many streams are live. When the budget is exhausted a flush tick
 * defers to the next tick rather than calling the API.
 */
const STREAM_NATIVE_APPEND_RATE_PER_MIN = 90;
const STREAM_NATIVE_APPEND_BURST = 8;

/**
 * Idle keepalive interval. Slack auto-finalizes a streaming message after an
 * (undocumented) idle period; once that happens every append fails with
 * `message_not_in_streaming_state`. While a stream is open with no pending
 * chunks, we re-send the last task_update (an idempotent, invisible no-op)
 * this often to keep it alive through long tool-execution gaps.
 *
 * Spike-verified 2026-07-02: a chunk-mode stream survived 95s of total
 * silence, and idempotent task_update re-sends are accepted indefinitely —
 * so 15s is comfortably safe while staying cheap on the append budget.
 */
const STREAM_NATIVE_KEEPALIVE_MS = 15_000;

/**
 * Keepalive token: a zero-width space. Stream content is append-only (it can't
 * be retracted before stopStream), so the keepalive must render invisibly in
 * the finalized message — U+200B does, while a literal space or visible cursor
 * would persist as noise.
 */
const STREAM_KEEPALIVE_TOKEN = '\u200b';

/**
 * Title of the plan box that groups the turn's task cards (live stream and
 * rebuilt messages). Plain text without emoji \u2014 plan/container titles render
 * emoji shortcodes literally instead of as emoji.
 */
const WORK_LOG_TITLE = 'Work log';

/** Title for the details message text fallback / legacy attachment (mrkdwn-rendered). */
const DETAILS_TITLE = '\ud83d\udccb Details';

/** Title of the collapsible details container \u2014 plain text, no emoji (see above). */
const DETAILS_CONTAINER_TITLE = 'Details';

/**
 * Slack caps `task_update` title/details/output at 256 chars per update.
 * TASK_DETAILS_MAX leaves headroom for the `\u2026` prefix on rolling reasoning tails.
 */
const TASK_TITLE_MAX = 256;
const TASK_DETAILS_MAX = 250;

/** Title of the rolling reasoning task card. */
const THINKING_TASK_TITLE = 'Thinking';

export {
  STREAM_UPDATE_INTERVAL_MS,
  STREAMING_INDICATOR,
  ANSWER_STREAMING_REACTION,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
  WORK_LOG_TITLE,
  DETAILS_TITLE,
  DETAILS_CONTAINER_TITLE,
  TASK_TITLE_MAX,
  TASK_DETAILS_MAX,
  THINKING_TASK_TITLE,
  STREAM_NATIVE_APPEND_RATE_PER_MIN,
  STREAM_NATIVE_APPEND_BURST,
};

/**
 * Marker the model emits on its own line to separate the concise TL;DR answer
 * from the expandable detail section. Everything before the first marker becomes
 * the answer bubble; everything after becomes a collapsed "Details" attachment.
 * Tolerant of surrounding whitespace, 2+ dashes on either side, and case.
 */
const DETAILS_MARKER = /(?:^|\n)[ \t]*-{2,}[ \t]*DETAILS[ \t]*-{2,}[ \t]*(?=\n|$)/i;

/**
 * Find the first {@link DETAILS_MARKER} that is NOT inside a fenced code block
 * (a marker in a fence is content the model is showing, not a fold directive).
 * Uses the same fence regex as {@link markdownToSlackMrkdwn} so both agree on
 * what counts as code.
 */
export function findDetailsMarker(text: string): { index: number; length: number } | null {
  const codeBlockRe = /```\w*\n[\s\S]*?```/g;
  let lastIndex = 0;
  for (const m of text.matchAll(codeBlockRe)) {
    const hit = DETAILS_MARKER.exec(text.slice(lastIndex, m.index));
    if (hit) return { index: lastIndex + hit.index, length: hit[0].length };
    lastIndex = m.index + m[0].length;
  }
  const hit = DETAILS_MARKER.exec(text.slice(lastIndex));
  return hit ? { index: lastIndex + hit.index, length: hit[0].length } : null;
}

/**
 * Split model output into the TL;DR `body` and an optional `details` section on
 * the first {@link DETAILS_MARKER} outside a code fence. Returns `details: null`
 * (whole text as body, unfolded) when the marker is absent or nothing follows
 * it; if nothing precedes it, the post-marker content becomes the body. The
 * marker line itself is always dropped so it never leaks into a delivered
 * message.
 */
export function splitDetails(text: string): { body: string; details: string | null } {
  const match = findDetailsMarker(text);
  if (!match) return { body: text, details: null };
  const body = text.slice(0, match.index).trimEnd();
  const details = text.slice(match.index + match.length).trim();
  if (!details) return { body, details: null };
  if (!body) return { body: details, details: null };
  return { body, details };
}

const TOOL_DISPLAY_VERBS: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Bash: 'Running',
  Glob: 'Searching files',
  Grep: 'Searching',
  LS: 'Listing',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  Agent: 'Delegating to agent',
  Task: 'Delegating',
};

export function formatToolStatus(toolName: string, keyArg: string | null): string {
  const verb = TOOL_DISPLAY_VERBS[toolName] ?? `Using ${toolName}`;
  if (keyArg) {
    return `:thinking_face: _${verb} \`${keyArg}\`..._`;
  }
  return `:thinking_face: _${verb}..._`;
}

/** Key args longer than this add noise, not information, to a one-line card title. */
const TASK_TITLE_KEY_ARG_MAX = 100;

/**
 * Format a tool step as a task-card title for the live Thinking Steps work log.
 * Plain text (task_card titles don't render mrkdwn). MCP tool ids
 * (`mcp__<server>__<tool>`) are shown as `<tool> (<server>)`; long key args are
 * trimmed so the card stays a readable one-liner.
 */
export function formatToolTaskTitle(toolName: string, keyArg: string | null): string {
  let verb = TOOL_DISPLAY_VERBS[toolName];
  if (!verb) {
    const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
    verb = mcp ? `Using ${mcp[2]} (${mcp[1]})` : `Using ${toolName}`;
  }
  const arg =
    keyArg && keyArg.length > TASK_TITLE_KEY_ARG_MAX
      ? `${keyArg.slice(0, TASK_TITLE_KEY_ARG_MAX - 1)}…`
      : keyArg;
  const title = arg ? `${verb} ${arg}` : verb;
  return title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1)}…` : title;
}

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}
