# Slack streaming rework: Thinking Steps migration + reliability fixes

## Context

The Slack `stream-native` mode streams a "🧠 Work log" and an answer as two separate native Slack streams, then "collapses" the work log by rewriting it into a legacy attachment that Slack auto-folds behind "Show more" (~700 chars / 5 line breaks). Problems reported and confirmed in code:

1. **Work log stays expanded forever when anything goes wrong.** In `src/core/engine.ts` (L300–321) any runner error/timeout skips `onStreamComplete`; only `finish()` runs in `finally`, so `collapseNotes` never fires. A second user message mid-generation makes long turns/timeouts more likely — matching the reported symptom.
2. **Collapse is single-shot, no retry** (`collapseNotes`, `responder.ts` L1058–1101) — one failed `chat.update` (429, transient, or stream not cleanly stopped) leaves the log expanded permanently.
3. **The attachment fold is a hack** — always shows 4–5 lines when "collapsed"; short logs never fold at all.
4. **Work-log vs answer vs Details split is heuristic and fragile**: late tool/subagent events retroactively reclassify the real answer as narration; missing `result.text` (kill/timeout) redelivers narration-dirty text; the `-- DETAILS --` regex isn't code-fence-aware.
5. **Latent race**: `entry.currentTurn` in `src/claude.ts` (L1439) is silently overwritten with no guard — an overlapping turn would orphan the previous turn's promise (frozen work log, leaked process slot). Serialization (`channelBusy`) currently prevents it, but nothing enforces it.

Slack now provides purpose-built primitives (verified against official docs, July 2026; installed `@slack/web-api` 7.16.0 already has the types):
- **Thinking Steps**: `task_update`/`plan_update` chunks on `chat.startStream`/`appendStream`/`stopStream` render an agent work log as task cards — live-expandable while streaming, **collapsed by default when done**. `chat.appendStream` is Tier 4 (100+/min).
- **`container` block** (GA 2026-06-29): `is_collapsible` + `default_collapsed` — collapses to a single title row, per-user client-side expand. Not yet in SDK types (local interface + cast; runtime acceptance verified in spike).

**Decisions made with the user**: migrate the work log to Thinking Steps (single streamed message per turn); deliver the Details section as a collapsed `container` block set via `chat.stopStream` final blocks (attachment fallback); full tidy scope.

## Design decisions

- **D1 — One `SlackTurnStream`, opened eagerly** in the responder constructor with an initial `task_update {id:'t0', title:'Thinking', status:'in_progress'}` + `task_display_mode:'timeline'`. The stream itself is the instant feedback → deletes the placeholder machinery (~80 lines + races).
- **D2 — Reasoning → rolling "Thinking" task cards**: one card per reasoning burst (`thinking-N`), `details` = rolling tail (~250 chars, word-trimmed), flipped to `complete` at the next non-reasoning event. (256-char cap per task_update field.)
- **D3 — Tool events → task cards with stable ids**: `start` → in_progress card (verb from `TOOL_DISPLAY_VERBS`); `complete` → same id, title `verb keyArg`, status complete. `subagent_progress/completed` update the in-flight Agent card's details/output.
- **D4 — Narration stays in the markdown body** (timeline mode interleaves markdown and cards in arrival order — spike-verified). Deletes the retroactive reclassification hack (`flushNarration`, `pendingTextRun`, `answerDirty`, `writeNote`, `lastNoteKind`). Keep `lastTextRun` for the divergence check (D6).
- **D5 — Details withheld live** by a `DetailsGate` that scans outgoing text for `-- DETAILS --` before it hits the wire (code-fence-parity aware, holds back ambiguous tails). On clean finish: `stopStream({ blocks: [container('📋 Details', …)] })`. Fallback on `invalid_blocks`: existing grey-blue details attachment message.
- **D6 — Rebuild = `chat.update` with reconstructed blocks** when the stream broke, the marker slipped through, or `result.text` diverges from `lastTextRun`. `TaskTracker` is the source of truth: blocks = `plan('🧠 Work log', taskCards) + answer sections + container('📋 Details')`. Narration intentionally dropped in rebuilds. **If `result.response` is empty, no rebuild at all** — the streamed body stands (fixes the narration-dirty redelivery bug).
- **D7 — Crash-proof finalization**: `IStreamingResponder.finish(outcome?: {ok, errorMessage?})`; engine's `finally` calls `sr.finish({ok:false, errorMessage})` on error paths. `finish` closes open cards (`error` status on failure) and stops the stream with bounded retry (3 attempts, 500/1500ms backoff) on `stopStream` and the rebuild `chat.update`. Cards render collapsed by default → work log always ends collapsed, even on error.
- **D8 — Keepalive**: keep 5s keepalive; prefer idempotent re-send of the last `task_update` (truly invisible) over the zero-width-space token; ZWSP fallback when no task exists yet. Spike-verified.
- **D9 — Modes/config**: no new config. `stream-update` mode (`StreamingResponder`) kept unchanged as legacy fallback. `collapseWorkingNotes: false` now only suppresses Thinking cards (tool cards are collapsed-by-default anyway); the no-collapse status-line machinery is deleted. If `startStream` fails terminally, the responder accumulates and `onStreamComplete` delivers fresh via the consolidated delivery helper.
- **D10 — Rate limiting**: shared appendStream token bucket unchanged (90/min, burst 8); chunks batch into one call per 700ms flush tick.
- **D11 — partyparrot reaction**: kept, trivially simplified — single stream, add at open / remove at finish. First-stream-preference logic deleted.

## Ordered work items

### Step 0 — Spike (BLOCKING, do first)
Throwaway script in the scratchpad, run with `bun` against the dev workspace, verifying: (1) `startStream` with a task chunk + `task_display_mode:'timeline'`; (2) markdown/task chunk **interleaving order** + live in-place card updates + 256-char overflow behavior (error vs truncation); (3) idle auto-finalize with cards, and whether idempotent task_update re-send keeps it alive (decides D8); (4) `stopStream` with a `container` block — accepted, renders collapsed? (decides D5 default vs attachment fallback); (5) `chat.update` on the finalized message with `plan`/`task_card`/`container` blocks (decides D6; if rejected, rebuild shrinks to sections + details attachment); (6) `task_display_mode:'plan'` comparison. Record outcomes as comments next to the relevant constants.

### Step 1 — `src/adapters/slack/formatting.ts`
- Rewrite `splitDetails` (L171–179) fence-aware (reuse the fence-splitting approach from `markdownToSlackMrkdwn` L12–31); same return contract.
- Add `TASK_TITLE_MAX = 256`, `TASK_DETAILS_MAX = 250`, `THINKING_TASK_TITLE`, `formatToolTaskTitle(toolName, keyArg)` (from `formatToolNote` sans emoji/italics).
- Later deletion (Step 5): `STREAM_LIVE_NOTES_PREFIX`, `WORKING_NOTES_TITLE`, `formatToolNote` (Slack-only). `formatToolStatus` stays (`StreamingResponder`).

### Step 2 — `src/claude.ts`: `currentTurn` guard
In `runClaudePersistentStreaming` (L1432–1449): if `entry.currentTurn` is non-null, reject the new call loudly (`A turn is already in progress for <regKey>`) without touching the existing turn. Reject-new, not queue — overlap is a bug that must surface.

### Step 3 — New `src/adapters/slack/stream.ts`: `SlackTurnStream`
Port of `SlackTextStream` generalized to an **ordered chunk queue** (preserves markdown/task interleaving): `start(initialChunks)` (eager, buffers appends until ts lands), `appendMarkdown(text)` (coalesce adjacent markdown), `appendTask(update)` (coalesce same-id, last wins), `stop({chunks?, blocks?})` (idempotent, 3-attempt retry on transient errors), `ts/deliveredOk/broken`. Keeps: 700ms flush timer, pending-cleared-only-on-success, `STREAM_CLOSED_ERROR_CODES` terminal-vs-transient classification, shared token bucket (`tryConsumeAppendToken` + `__resetAppendRateLimiterForTest` move here), keepalive per D8.

### Step 4 — New `src/adapters/slack/thinking-steps.ts`: `TaskTracker` + `DetailsGate`
Pure state classes (no WebClient → unit-testable): `TaskTracker` (toolStart/toolComplete by LIFO toolName match, subagent updates, `reasoningDelta` rolling Thinking card, `boundary()`, `closeAll(status, details?)`, `toBlocks()` for rebuilds, `hasTasks()`); `DetailsGate` (`push(text) → wire-safe visible text`, `finish() → {tail, details|null}`). Local `ContainerBlock` interface + `buildDetailsContainer(details)` enforcing ≤10 child sections / ≤2,900 chars each / ~7,000 total truncation.

### Step 5 — Rewrite `NativeStreamingResponder` (`responder.ts` L475–783)
- Constructor: one `SlackTurnStream`, eager `start([thinkingCard])`, reaction in `onStart`.
- `onTextDelta`: `tracker.boundary()` → appendTask; `stream.appendMarkdown(gate.push(text))`; track `fullText` + `lastTextRun`.
- `onReasoningDelta`: reset run boundary; if `collapse`, `tracker.reasoningDelta` → appendTask.
- `onToolEvent`: reset run boundary; map via `TaskTracker`.
- `finish(outcome?)`: `gate.finish()` tail → append; `tracker.closeAll(ok?'complete':'error', errorMessage)`; `stream.stop({chunks, blocks:[detailsContainer?]})` with attachment fallback; remove reaction. Idempotent.
- Accessors: `getFullText/getLastTextRun/getDetails/getStreamTs/streamDeliveredOk/getTaskBlocks/detailsDelivered`.
- **Delete**: `SlackTextStream` usage, notes stream + `ensureNotes/notesText/writeNote/lastNoteKind`, `flushNarration/pendingTextRun/answerDirty`, all placeholder fields + `removePlaceholder`, `statusChain/statusTs/statusAdoptedPlaceholder/handleStatusMessage`, first-stream reaction preference, `getNotesTs/getNotesText/isAnswerDirty`.

### Step 6 — `SlackChannelResponder` tidy + new `src/adapters/slack/delivery.ts`
- `deliverText(client, {channel, threadTs, text, replaceTs?, replaceBlocksPrefix?, detailsMode})` owning: `FILE_THRESHOLD` → `files.uploadV2` (upload-first, then best-effort delete of `replaceTs`); fence-aware `splitDetails`; `markdownToSlackMrkdwn` + `splitMessage`; update-first-chunk-then-post-rest; details via container (attachment fallback); 3-attempt transient retry. Keep `postDetailsAttachment` as the fallback primitive.
- `sendResponse` (L785–817), stream-update branch of `onStreamComplete` (L937–992), `deliverFinalText` (L1001–1047) collapse into `deliverText`. **Delete** `deliverFinalText`, `collapseNotes`, copy-pasted upload/truncate blocks; `WORKING_NOTES_MAX_CHARS` moves into delivery.ts as the details cap.
- `onStreamComplete` (stream-native): `needsRebuild = !streamDeliveredOk() || markerSlippedThrough || (result text && normalized(result) !== normalized(lastTextRun))`; rebuild → `deliverText` with `replaceTs=getStreamTs()`, `replaceBlocksPrefix=getTaskBlocks()`; deliver details if not delivered at stop; **empty-answer turns keep the message** (it holds the task cards — replaces the old "drop empty bubble" branch).

### Step 7 — `src/core/interfaces.ts` + `src/core/engine.ts`
- `finish(outcome?: {ok: boolean; errorMessage?: string})` (backward compatible; voice responder + `StreamingResponder` ignore the arg).
- Engine (L233–330): capture the scrubbed error message where `finally` can see it; cleanup becomes `if (sr && !streamFinished) await sr.finish({ok:false, errorMessage})`. Success path unchanged. **This is the fix for the never-collapsed work log.**

### Step 8 — Tests
- `src/__tests__/slack.test.ts` (main effort): mock client captures `chunks`/`blocks`; rewrite two-stream expectations to single-stream. New: same-id task_update in_progress→complete with truncated title; rolling Thinking tail ≤256 + completed at boundary; narration stays in markdown chunks; DetailsGate keeps `-- DETAILS --` off the wire + container at stop; fenced marker streams through; `finish({ok:false})` → error cards + stopStream still called; transient stopStream retried, attachment fallback on `invalid_blocks`; broken-stream rebuild includes plan/task blocks; startStream-fails-terminally degradation; missing-result fallback does **no** rebuild. `splitDetails` fence cases.
- `src/__tests__/engine.test.ts`: throwing runner → `finish({ok:false, errorMessage})` exactly once, after `onError`.
- `src/__tests__/claude.test.ts`: second concurrent `runClaudePersistentStreaming` on same regKey rejects; first turn intact.
- `src/__tests__/model-override.test.ts`: fix `__resetAppendRateLimiterForTest` import path.

## Verification
`bun test` + `make server-typecheck`, then smoke-test against the dev workspace (`responseMode: 'stream-native'`):
1. Simple Q&A: text streams, `t0` Thinking card completes, clean stop.
2. Multi-tool task: cards per tool live-update to complete; narration interleaves; final body matches `result.text` (no rebuild `chat.update` in logs).
3. `-- DETAILS --` prompt: marker never visible live; collapsed "📋 Details" container (or attachment if spike forced fallback).
4. Marker inside a code fence: renders literally, no fold.
5. Long tool gap (>2 min Bash sleep): stream survives via keepalive; if it dies, rebuild restores cards + answer.
6. Kill/timeout mid-turn (tiny `timeoutMs`): message finalizes with error-status cards, collapsed; error reply posted; no perpetually-live stream. **Also: send a second message mid-generation and confirm both turns' logs end collapsed.**
7. >12k response: file upload; stream message retains task cards.
8. Two channels streaming concurrently: rate limiter defers without breakage.
9. `stream-update` regression pass (behavior unchanged).

## Critical files
- `src/adapters/slack/responder.ts` (major rewrite)
- `src/adapters/slack/stream.ts`, `src/adapters/slack/thinking-steps.ts`, `src/adapters/slack/delivery.ts` (new)
- `src/adapters/slack/formatting.ts`, `src/core/engine.ts`, `src/core/interfaces.ts`, `src/claude.ts`
- `src/__tests__/slack.test.ts`, `engine.test.ts`, `claude.test.ts`, `model-override.test.ts`

## Risks (resolved by Step 0 before rework code is written)
(a) markdown/task chunk interleaving order; (b) idle-finalize behavior with task cards; (c) `container` block acceptance at `stopStream`; (d) `chat.update` accepting `plan`/`task_card` blocks on a finalized stream message; (e) 256-cap failure mode (hard error vs truncation).
