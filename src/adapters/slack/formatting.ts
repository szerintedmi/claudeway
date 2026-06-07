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
  result = result.replace(/</g, '&lt;');

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
 * text, we append an invisible keepalive token this often to keep it alive
 * through long tool-execution gaps.
 *
 * NOTE: Slack does not publish the idle-timeout value, so this is a
 * conservative guess — tune it down if streams still die on long tasks. The
 * onStreamComplete fallback still delivers the full text if a stream dies.
 */
const STREAM_NATIVE_KEEPALIVE_MS = 5000;

/**
 * Keepalive token: a zero-width space. Stream content is append-only (it can't
 * be retracted before stopStream), so the keepalive must render invisibly in
 * the finalized message — U+200B does, while a literal space or visible cursor
 * would persist as noise.
 */
const STREAM_KEEPALIVE_TOKEN = '\u200b';

export {
  STREAM_UPDATE_INTERVAL_MS,
  STREAMING_INDICATOR,
  STREAM_NATIVE_FLUSH_INTERVAL_MS,
  STREAM_NATIVE_KEEPALIVE_MS,
  STREAM_KEEPALIVE_TOKEN,
  STREAM_NATIVE_APPEND_RATE_PER_MIN,
  STREAM_NATIVE_APPEND_BURST,
};

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
