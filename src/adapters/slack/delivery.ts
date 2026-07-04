import type { WebClient } from '@slack/web-api';
import type { Block } from '@slack/types';
import {
  markdownToSlackMrkdwn,
  splitMessage,
  splitDetails,
  inlineDetailsMarker,
  chunkText,
  FILE_THRESHOLD,
} from './formatting.js';

/** Section blocks cap text at 3000 chars; stay under when chunking a body into blocks. */
const SECTION_MAX_CHARS = 2900;

/** Total cap on folded details content (Slack hard-truncates around 8000). */
export const DETAILS_MAX_CHARS = 7000;
/** Container blocks accept at most 10 child blocks. */
const CONTAINER_MAX_CHILDREN = 10;
/** Title of the collapsed details container — plain text (emoji shortcodes render literally). */
const DETAILS_CONTAINER_TITLE = 'Details';

/**
 * `container` block (GA 2026-06-29) — not yet in @slack/types 7.x, so declared
 * locally. Spike-verified: the API requires `title` as a plain_text object
 * (the docs' "string" is the text inside it).
 */
interface ContainerBlock {
  type: 'container';
  title: { type: 'plain_text'; text: string; emoji?: boolean };
  is_collapsible?: boolean;
  default_collapsed?: boolean;
  /** Rendered width; default 'standard' looks boxed-in next to message text. */
  width?: 'narrow' | 'standard' | 'wide' | 'full';
  child_blocks: Block[];
}

/**
 * Build the collapsed "Details" container for the folded detail section.
 * Content is capped and chunked into section blocks under the container's
 * child-block limit.
 */
export function buildDetailsContainer(details: string): ContainerBlock {
  const capped =
    details.length > DETAILS_MAX_CHARS
      ? `${details.slice(0, DETAILS_MAX_CHARS)}\n\n_…(truncated)_`
      : details;
  // Fence-aware, surrogate-safe chunking (the old raw slice(i, i+2900) split code
  // fences mid-block and could bisect a 2-unit emoji).
  const children: Block[] = chunkText(capped, SECTION_MAX_CHARS)
    .slice(0, CONTAINER_MAX_CHILDREN)
    .map(
      (text) =>
        ({
          type: 'section',
          text: { type: 'mrkdwn', text },
        }) as Block,
    );
  return {
    type: 'container',
    title: { type: 'plain_text', text: DETAILS_CONTAINER_TITLE, emoji: true },
    is_collapsible: true,
    default_collapsed: true,
    width: 'full',
    child_blocks: children,
  };
}

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

/** Chunk mrkdwn text into section blocks under the per-section char cap. */
export function mrkdwnSections(mrkdwn: string): Block[] {
  return chunkText(mrkdwn, SECTION_MAX_CHARS, { trimContinuation: 'newlines' }).map(
    (text) =>
      ({
        type: 'section',
        text: { type: 'mrkdwn', text },
      }) as Block,
  );
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
 * upload; a details section folds into a collapsed container below the body
 * (block layout, with the work-log cards kept on top when rewriting); plain
 * text otherwise, replacing `replaceTs` in place when given (posting overflow
 * chunks as follow-ups) or posting fresh. When the block layout is rejected,
 * falls back to plain text with the details rendered behind the inline header.
 * Final calls retried on transient failures.
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
        content: inlineDetailsMarker(text),
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

  // Block layout when there is a details section to fold and/or work-log cards
  // to keep: cards on top, body as section blocks, details as a collapsed
  // container at the bottom. Sections cap at 2900 chars, so the whole body
  // fits in one message.
  const { body, details } = splitDetails(text);
  const hasPrefix = replaceTs != null && (replaceBlocksPrefix?.length ?? 0) > 0;
  if (body.trim().length > 0 && (details !== null || hasPrefix)) {
    const bodyMrkdwn = markdownToSlackMrkdwn(body);
    const blocks = [
      ...(hasPrefix ? replaceBlocksPrefix! : []),
      ...mrkdwnSections(bodyMrkdwn),
      ...(details !== null ? [buildDetailsContainer(markdownToSlackMrkdwn(details))] : []),
    ];
    const notification = splitMessage(bodyMrkdwn)[0];
    try {
      if (replaceTs) {
        await withRetry('final message rebuild', () =>
          client.chat.update({
            channel,
            ts: replaceTs,
            text: notification,
            blocks: blocks as never,
          }),
        );
      } else {
        await withRetry('response post', () =>
          client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: notification,
            blocks: blocks as never,
          }),
        );
      }
      return;
    } catch (err) {
      // Block layout rejected (e.g. container/plan refused on this surface) —
      // fall through to plain text with the details behind the inline header.
      console.error('[slack] block delivery failed, falling back to plain text:', err);
    }
  }

  const formatted = markdownToSlackMrkdwn(inlineDetailsMarker(text));
  const chunks = splitMessage(formatted);

  let startIdx = 0;
  if (replaceTs && chunks.length > 0) {
    try {
      await withRetry('final message update', () =>
        client.chat.update({ channel, ts: replaceTs, text: chunks[0] }),
      );
      startIdx = 1;
    } catch (err) {
      console.error('[slack] in-place rewrite failed, posting fresh:', err);
    }
  }
  for (let i = startIdx; i < chunks.length; i++) {
    await withRetry('response post', () =>
      client.chat.postMessage({ channel, thread_ts: threadTs, text: chunks[i] }),
    );
  }
}
