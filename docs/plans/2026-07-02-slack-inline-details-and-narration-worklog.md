# Slack streaming: inline Details + narration → work log

Date: 2026-07-02 (addendum 2026-07-03)
Status: approved (follow-up to 2026-07-02-slack-thinking-steps-streaming.md)

## Addendum (2026-07-03): fold-at-finish + step cards

Live feedback after the first cut: the inline Details section never collapses,
and the work log is noisy (a bold checkmarked card per tool + per narration
line, wide spacing). Slack-docs research findings that drive the fixes:

- Streamed markdown is append-only; the only way to collapse content after
  the fact is a post-stop `chat.update` rewrite (already proven by our rebuild
  path). `container` (`is_collapsible` + `default_collapsed`, ≤10 children) is
  the only Block Kit primitive with guaranteed controllable collapse; section
  `expand:false` is client-discretionary, attachments (legacy) collapse at
  700 chars/5 breaks.
- Task cards: status icons, spacing, and typography are NOT controllable;
  `details`/`output` render as lighter secondary lines under the bold title.
  `task_update` fields cap at 256 chars. (New `task_display_mode: 'dense'`
  exists but is undocumented beyond one sentence — not adopted.)

Decisions:

1. **Details fold at finish.** Keep streaming the details inline (live), and
   when the turn carried a details section, rewrite the message at finish via
   the existing rebuild path: work-log plan block + body as section blocks +
   a collapsed `Details` container. Failure fallback: plain-text delivery
   with the inline header. Batch/legacy modes fold the same way through
   `deliverText`.
2. **Step cards.** Each demoted narration run opens an `in_progress` "step"
   card (title = narration text). Tool calls under an open step stop getting
   their own cards — they append to the step's `details` log
   (lighter/smaller), as do subagent progress (`details`) and subagent
   completion summaries (`output`). The step completes at the next narration,
   at answer release, or at close. Tools arriving before any narration keep
   standalone cards (unchanged). Result: one bold checkmarked line per
   narrated step instead of per tool, and the checkmark now means "step done".
3. **`details`/`output` are APPEND-only on the wire** — spike-verified
   2026-07-03 against the dev workspace (undocumented; explains the live
   "ReadingReadingReading" duplication): re-sending a task_update concatenates
   its `details`, including identical re-sends, while `title`/`status`
   replace. Consequences implemented:
   - chunks carry only field *deltas* (one completed-tool line per update,
     newline-terminated); a capped accumulated copy is stored per card for
     the blocks rebuild;
   - the reasoning card streams delta text, capped at 500 chars live (stored
     rolling tail for rebuilds);
   - keepalive re-sends strip `details`/`output` (title/status only);
   - stream-level same-id coalescing concatenates `details`/`output` instead
     of last-wins.
   End-to-end verified by driving the real responder through a full turn in
   the owner DM: clean step logs, no duplication, collapsed Details container
   on the finalized message (post-stop `chat.update` fold confirmed).

## Problems

1. **Details don't stream.** The `DetailsGate` withholds everything after the
   `-- DETAILS --` marker and the folded section is delivered as a collapsed
   `container` block attached at `chat.stopStream`. The user-visible effect:
   the answer finishes streaming, then a long silent wait (the model is still
   generating the withheld details), then the whole container appears at once.
   Streaming *into* a container is not possible — the streaming API only
   accepts `markdown_text` / `task_update` / `plan_update` chunks plus a
   static one-shot `blocks` insert; nothing can incrementally update a
   container's children.

2. **Narration leaks into the final answer.** Extended-thinking deltas route
   correctly to the Thinking card, but *narration* — ordinary assistant text
   blocks emitted between tool calls ("Let me fetch the most recent trace…")
   — arrives as `text_delta` and is streamed straight into the message body,
   where it permanently precedes the real answer. At delta time narration is
   indistinguishable from the answer; the discriminator is only what comes
   next (another tool/thinking event ⇒ narration; end of turn ⇒ answer).
   Streamed markdown cannot be retracted.

## Decisions

### 1. Inline details (drop the container)

Replace the withhold-then-fold behavior with a marker→header transform:

- `DetailsGate` keeps its fence-aware line scanning and partial-line holdback,
  but on the marker line it emits an inline header
  (`\n---\n\n**📋 Details**\n\n`) and lets everything after it stream live.
  Slack's own "Show more" cut handles long messages.
- Header is withheld until the details section proves non-empty (no dangling
  header for an empty section); when nothing visible precedes the marker the
  header is skipped and the details stream as the body — mirrors
  `splitDetails` edge-case semantics.
- Same inline rendering in the rebuild/batch path: `deliverText` renders
  `inlineDetailsMarker(text)` instead of splitting out a separate details
  message. Legacy `stream-update` mode rewrites its bubble with the inlined
  text at completion.
- Delete: `buildDetailsContainer`, `ContainerBlock`, `postDetailsMessage`,
  `postDetailsAttachment`, `DETAILS_TITLE`/`DETAILS_CONTAINER_TITLE`, the
  `blocks` option of `SlackTurnStream.stop` (+ `invalid_blocks` retry and
  `droppedFinalBlocks`), and the responder's `getDetails`/`detailsDelivered`.

Trade-off accepted: details are visible inline (no collapsed-by-default box);
full response stays in the Slack message.

### 2. Narration → work log (buffer-and-classify)

Hold each answer-role text run in a buffer instead of streaming immediately:

- A tool/thinking event arriving while the run is buffered ⇒ the run was
  narration ⇒ emit it as a **completed work-log card** (`TaskTracker.
  narration()`): title = whitespace-flattened text truncated to the 256-char
  card-title cap, overflow into the 250-char `details` field.
- The buffered run growing past `NARRATION_HOLDBACK_MAX_CHARS` (500) ⇒ it is
  the answer ⇒ release it to the body (close any open Thinking card first)
  and stream the rest of the run live.
- At `finish()`, a still-buffered run is the answer — pushed through the gate
  and delivered in the `stopStream` tail chunks.
- Classification is gated on `collapseWorkingNotes` (same flag that gates
  reasoning cards); when false, text streams directly to the body as before.

Accepted limitations (revisit only if they bite):

- A narration run longer than 500 chars is released and leaks into the body
  (old behavior). No finish-time rewrite backstop in this cut.
- Short answers (<500 chars) appear at stop rather than streaming — the
  `result` event follows the final text block almost immediately, so the
  added latency is sub-second.
- Narration >~500 chars in a card is truncated (title 256 + details 250).

`lastTextRun` bookkeeping and the `answerAlreadyLive` rebuild check are
unchanged: narration runs still reset the run, the final run must match the
authoritative `result` text.

## Touched files

- `src/adapters/slack/thinking-steps.ts` — DetailsGate rework,
  `TaskTracker.narration()`, container machinery deleted
- `src/adapters/slack/formatting.ts` — `DETAILS_INLINE_HEADER`,
  `inlineDetailsMarker()`, `NARRATION_HOLDBACK_MAX_CHARS`; details-title
  constants deleted
- `src/adapters/slack/responder.ts` — buffer-and-classify in
  `NativeStreamingResponder`, container/details-message delivery removed,
  legacy path inlines the marker
- `src/adapters/slack/delivery.ts` — inline rendering, details messages gone
- `src/adapters/slack/stream.ts` — `stop()` loses the `blocks` option
- `src/__tests__/slack.test.ts` — updated + new coverage
- `config.example.yaml` — systemPrompt wording ("folded attachment" → inline
  section); `docs/configuration.md` `collapseWorkingNotes` row mentions
  narration routing
