import type { WebClient } from '@slack/web-api';
import type { Block } from '@slack/types';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  splitDetails,
  FILE_THRESHOLD,
  DETAILS_TITLE,
  DETAILS_CONTAINER_TITLE,
} from './formatting.js';
import { buildDetailsContainer, DETAILS_MAX_CHARS } from './thinking-steps.js';

/** Grey-blue accent for the folded "📋 Details" attachment (container fallback). */
const DETAILS_ATTACHMENT_COLOR = '#6a8fb5';

/** Section blocks cap text at 3000 chars; stay under when chunking a body into blocks. */
const SECTION_MAX_CHARS = 2900;

/** Retry delays for final delivery calls (update/post) — a single transient
 * failure must not leave a turn undelivered or a live message unrewritten. */
const RETRY_DELAYS_MS = [500, 1500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      console.error(`[slack] ${label} failed (attempt ${attempt + 1}), retrying:`, err);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Post the folded detail section as its own attachment message. Slack
 * auto-collapses attachment text behind "Show more…" past ~700 chars / 5 line
 * breaks. Fallback path for workspaces/clients where the `container` block is
 * rejected. Best effort — a failure here must never block the answer that was
 * already delivered.
 */
export async function postDetailsAttachment(
  client: WebClient,
  channel: string,
  threadTs: string,
  details: string,
): Promise<void> {
  const trimmed = details.trim();
  if (!trimmed) return;
  const body =
    trimmed.length > DETAILS_MAX_CHARS
      ? `${trimmed.slice(0, DETAILS_MAX_CHARS)}\n\n_…(truncated)_`
      : trimmed;
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: DETAILS_TITLE,
      attachments: [
        {
          color: DETAILS_ATTACHMENT_COLOR,
          fallback: DETAILS_TITLE,
          text: markdownToSlackMrkdwn(body),
          mrkdwn_in: ['text' as const],
        },
      ],
    });
  } catch (err) {
    console.error('[slack] Failed to post details attachment:', err);
  }
}

/**
 * Deliver the folded detail section as a fresh message holding a collapsed
 * container block (a single "📋 Details" title row); falls back to the legacy
 * auto-folding attachment when the container is rejected.
 */
export async function postDetailsMessage(
  client: WebClient,
  channel: string,
  threadTs: string,
  details: string,
): Promise<void> {
  const trimmed = details.trim();
  if (!trimmed) return;
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: DETAILS_TITLE,
      blocks: [
        buildDetailsContainer(markdownToSlackMrkdwn(trimmed), DETAILS_CONTAINER_TITLE),
      ] as never,
    });
  } catch (err) {
    console.error('[slack] Details container rejected, falling back to attachment:', err);
    await postDetailsAttachment(client, channel, threadTs, trimmed);
  }
}

/** Chunk mrkdwn text into section blocks under the per-section char cap. */
export function mrkdwnSections(mrkdwn: string): Block[] {
  const sections: Block[] = [];
  let rest = mrkdwn;
  while (rest.length > 0) {
    let take =
      rest.length <= SECTION_MAX_CHARS ? rest.length : rest.lastIndexOf('\n', SECTION_MAX_CHARS);
    if (take <= 0) take = SECTION_MAX_CHARS;
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: rest.slice(0, take) },
    } as Block);
    rest = rest.slice(take).replace(/^\n+/, '');
  }
  return sections;
}

export interface DeliverTextOptions {
  channel: string;
  threadTs: string;
  /** Raw markdown response (may contain a `-- DETAILS --` fold marker). */
  text: string;
  /** Existing message to rewrite in place (streamed bubble); posts fresh when absent. */
  replaceTs?: string | null;
  /**
   * Blocks to keep at the top when rewriting (the rebuilt work-log plan block).
   * When present the rewrite uses block layout; otherwise plain text.
   */
  replaceBlocksPrefix?: Block[];
}

/**
 * Single delivery path for a complete response: oversized text becomes a file
 * upload, the fold marker splits out a Details section (container with
 * attachment fallback), the body replaces `replaceTs` in place when given
 * (posting overflow chunks as follow-ups) or posts fresh. Final calls retried
 * on transient failures.
 */
export async function deliverText(client: WebClient, opts: DeliverTextOptions): Promise<void> {
  const { channel, threadTs, text, replaceTs, replaceBlocksPrefix } = opts;

  if (text.length > FILE_THRESHOLD) {
    // Too large for a message — upload as a file FIRST so a failed upload never
    // loses the only copy (the partial message stays as a fallback).
    await withRetry('response file upload', () =>
      client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        content: text,
        filename: 'response.md',
        snippet_type: 'markdown',
        title: 'Response',
      }),
    );
    if (replaceTs) {
      if (replaceBlocksPrefix && replaceBlocksPrefix.length > 0) {
        // The streamed message holds the work-log cards — keep it, point at the file.
        try {
          await client.chat.update({
            channel,
            ts: replaceTs,
            text: 'Response uploaded as file',
            blocks: [
              ...replaceBlocksPrefix,
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '_Response was too long for a message — uploaded as a file in this thread._',
                },
              } as Block,
            ] as never,
          });
        } catch {
          // Best effort — the file is delivered either way
        }
      } else {
        try {
          await client.chat.delete({ channel, ts: replaceTs });
        } catch {
          // Best effort — may lack permission
        }
      }
    }
    return;
  }

  const { body, details } = splitDetails(text);
  const formatted = markdownToSlackMrkdwn(body);
  const chunks = splitMessage(formatted);

  let startIdx = 0;
  if (replaceTs && chunks.length > 0) {
    try {
      if (replaceBlocksPrefix && replaceBlocksPrefix.length > 0) {
        // Block layout rebuild: work-log cards on top, body as section blocks.
        // Sections cap at 2900 chars, so the whole body fits in one update.
        await withRetry('final message rebuild', () =>
          client.chat.update({
            channel,
            ts: replaceTs,
            text: chunks[0],
            blocks: [...replaceBlocksPrefix, ...mrkdwnSections(formatted)] as never,
          }),
        );
        startIdx = chunks.length;
      } else {
        await withRetry('final message update', () =>
          client.chat.update({ channel, ts: replaceTs, text: chunks[0] }),
        );
        startIdx = 1;
      }
    } catch (err) {
      if (replaceBlocksPrefix && replaceBlocksPrefix.length > 0) {
        // Block rebuild rejected (e.g. plan/task_card refused on this message) —
        // retry as a plain-text rewrite before posting everything fresh.
        try {
          await client.chat.update({ channel, ts: replaceTs, text: chunks[0] });
          startIdx = 1;
        } catch {
          console.error('[slack] in-place rewrite failed, posting fresh:', err);
        }
      } else {
        console.error('[slack] in-place rewrite failed, posting fresh:', err);
      }
    }
  }
  for (let i = startIdx; i < chunks.length; i++) {
    await withRetry('response post', () =>
      client.chat.postMessage({ channel, thread_ts: threadTs, text: chunks[i] }),
    );
  }
  if (details) await postDetailsMessage(client, channel, threadTs, details);
}
