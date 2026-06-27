# Working Notes / Reasoning rework

Date: 2026-06-27
Status: implemented (tests + typecheck + lint green; not yet verified end-to-end on a live Slack workspace)

## Known limitation

Stream ordering ("notes above answer") is locked by which stream opens first.
Reasoning streams before answer text in real Claude output, so notes open first.
The rare exception — a turn with narration text *before* any reasoning/tool, then
a tool — opens the answer stream first, so notes land below the answer. Accepted
(cosmetic, rare; current models emit thinking first by default).

## Problem

The Slack "🧠 Working notes" feature is flaky — often nothing shows. Investigation
found the root cause and several secondary issues.

### Root cause (confirmed empirically)

`parseStreamLine` in `src/claude.ts` parses `text_delta`, `result`, tool events and
subagent events, but **silently drops every `thinking_delta`**. The "Working notes"
have therefore never shown reasoning. What they actually accumulate is the model's
**intermediate text narration** (the `text_delta`s emitted between tool calls), with
the final answer (`result.text`) subtracted back out.

Verified against the installed CLI (2.1.195): reasoning *is* streamed by default as

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,
  "delta":{"type":"thinking_delta","thinking":"…"}}}
```

(field `event.delta.thinking`, on a `thinking` content block at index 0; the answer
is a separate `text` block). It is being discarded.

Flakiness follows directly: whether anything shows depends on whether the model wrote
prose between tool calls — unpredictable turn-to-turn. Tool→tool→answer turns (very
common) produce `fullText ≈ result` → `hasProcessNoise=false` → nothing.

### Secondary findings

1. `stripTrailingFinalAnswer` + `normalizeForAnswerBoundary` + `longestCommonSuffixLength`
   (~100 lines) exist only because the live message mixes narration + answer in one
   buffer, forcing the answer to be subtracted at the end via whitespace/quote/dash
   normalization. Fragile both ways (under-match → duplicated answer; over-cut → lost
   narration).
2. Notes post as a legacy attachment; Slack only shows "Show more…" collapse at ≥700
   chars or ≥5 newlines, so short notes aren't collapsible and attachments are legacy.
3. The live message is branded "Working notes (updating live…)" while actually
   streaming the *answer* on no-narration turns.
4. Some models (Opus 4.7+) can default to `display: omitted` → empty thinking; design
   must fall back gracefully (tools/narration) so notes never look broken.

## Decisions (from user)

- **Display model: two live streams.** A "🧠 Working notes" stream (reasoning + tool
  steps + narration) and an "Answer" stream, both updating live. On completion the
  notes collapse into an attachment above the kept answer. Slack allows concurrent
  streams in one thread (shared Tier-4 append budget).
- **Notes content: reasoning + tools + narration.**

## Design

### Reasoning channel (claude.ts → interfaces → engine)

- `parseStreamLine`: add `{ type: 'reasoning_delta'; text }` for
  `event.delta.type === 'thinking_delta'` (text from `event.delta.thinking`).
- `ClaudeStreamingOptions`: add optional `onReasoningDelta?(text)`.
- Wire through `runClaudeStreaming`, `runClaudePersistentStreaming`,
  `processPersistentLine`, and the one-shot streaming `processLine`.
- `IStreamingResponder`: add **optional** `onReasoningDelta?(text)` (voice responder
  ignores it — no interface break).
- Engine: `onReasoningDelta: (t) => streamer.onReasoningDelta?.(t)`.

### Narration vs answer — by event ordering, not string diffing

The responder sees reasoning/text/tool events in stream order. Rule: a run of text
that is followed by a tool or reasoning event was **narration**; the final text run
(nothing after it) is the **answer**. So narration for the notes is captured
*explicitly* per-run — no subtraction.

The answer stream still streams every text run live (optimistic). If any run is later
found to be narration, mark the answer stream "dirty"; at completion replace the
dirty answer stream with the verbatim `result.text` (delete + repost) — a simple
boolean, not normalization. If never dirty, keep the live answer as-is.

This **deletes** `stripTrailingFinalAnswer`, `normalizeForAnswerBoundary`,
`normalizeForCompare`'s answer use, and `longestCommonSuffixLength`.

### SlackTextStream helper

Extract the stream lifecycle (pending buffer, flush timer, keepalive, rate-limit
token, startStream/appendStream/stopStream, broken handling) from
`NativeStreamingResponder` into one reusable class. Instantiate twice (notes + answer).
Tool events become formatted lines appended to the notes stream (a growing step list),
replacing the thinkingTs/statusTs message-editing juggling.

## Out of scope

- `stream-update` (legacy) responder — unchanged.
- Voice adapter — reasoning ignored (no working-notes concept there).
