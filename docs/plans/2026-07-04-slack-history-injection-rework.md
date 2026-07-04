# Slack history injection rework

Date: 2026-07-04
Status: Phase 1 implemented (2026-07-04); Phase 2 (on-demand file fetch tool) not started

## Problem

Slack thread/history injection is currently noisy and partially redundant:

- `src/adapters/slack/handler.ts` fetches the whole prior Slack thread for every
  tagged thread reply, then `src/prompt.ts` prepends it as `[Thread context ...]`.
- `src/claude.ts` already runs Claude with a deterministic session id derived
  from `channelId + logical folder + threadTs`, so normal follow-up turns resume
  the same Claude session and prior tagged turns are already in Claude's
  transcript.
- `src/prompt.ts` also prepends `[Slack user reference]` on every queued prompt.
  The useful piece is the bot's own Slack identity; repeating every sender/name
  mapping per turn is avoidable.
- Thread entries do not include Slack channel/thread/message ids, so Claude
  cannot refer back to exact Slack messages.
- Files attached to the triggering message are eagerly downloaded and passed as
  local paths; files attached to other messages in the thread are currently
  invisible except for any extractable attachment text.

## Goals

- Only inject Slack messages Claude has not already seen in the resumed session.
- Preserve enough Slack metadata for Claude to cite or ask about exact messages:
  channel id, thread ts, message ts, author Slack id and display name.
- Remove the per-turn `[Slack user reference]` block entirely; carry user ids
  and display names in each message prefix, and carry the bot identity in the
  one-time new-session thread header.
- Include file metadata for prior-thread attachments without downloading every
  file by default.
- Keep Slack tokens and private download URLs out of prompts and Claude
  subprocess env.
- Keep queue/edit/restart behavior correct.

## Non-goals

- Do not rewrite Claude session-id derivation.
- Do not change voice history semantics in this pass.
- Do not eagerly download files attached to prior Slack-thread messages. Keep
  the current behavior for files attached to the message that tags/triggers the
  bot: those files are downloaded and passed to Claude as local readable paths.
- Do not expose `SLACK_BOT_TOKEN`, Slack private URLs, or raw Slack file URLs to
  Claude.

## Current Code Shape

- `registerMessageHandler()` builds final `QueuedMessage.text` at enqueue time:
  it downloads current-message files, fetches prior Slack replies, resolves a
  user directory, calls `buildPrompt()`, then enqueues the formatted text.
- `fetchThreadContext()` returns only `{ authorName, isBot, text }`; it drops
  message ts, user id, bot id, file metadata, and attachment file refs.
- `buildPrompt()` emits:

  ```text
  [Slack user reference]
  <@UBOT> = Claudeway (you)
  <@U123> = Alice

  [Thread context — N prior messages]
  [Alice]: ...

  [Current message]
  ...
  ```

- `updateQueuedMessage()` only replaces `QueuedMessage.text` and model/effort
  overrides, so any future structured history fields must be edit-aware.
- `buildClaudeArgs()` decides `--resume` vs `--session-id` by checking the
  local Claude session artifact, but the Slack prompt has already been rendered
  by then.

## Recommended Design

### 1. Store raw Slack turn data in the queue

Move Slack prompt rendering later. Queue entries should keep enough raw data to
rebuild the prompt just before processing:

- `channelId`
- `threadTs`
- current message `ts`
- sender Slack id and resolved display name when available
- raw current text after command/model/effort stripping
- attachment text extracted from Slack attachments
- current-message downloaded file paths
- current-message file metadata
- bot Slack id and display name when available

Add a structured `slack?: SlackQueuedTurn` payload. Cut over in one step per
entry: when the handler writes `slack`, it stops rendering at enqueue time and
`text` holds only the raw (post-strip) message text as a human-readable
fallback. Do not double-render (enqueue-time and processing-time) during
migration — that would double the Slack API traffic. `text` as a fully
pre-rendered prompt survives only in legacy queue files written before the
cutover; processing treats entries without `slack` as legacy and passes their
`text` through unchanged.

Keep `filePaths` as a top-level queue field (restart drains and the engine's
temp-dir bookkeeping use it), but see section 4 for suppressing the generic
attached-files footer when `slack` is present.

### 2. Prepare Slack prompts at processing time

Do not compute "history since last Claude turn" at enqueue time. Queued turns
make that wrong: a second queued message can be rendered before the first queued
message has actually entered Claude's session.

Placement constraint: the hook cannot resolve session state on its own. The
Claude session artifact lives under the *resolved cwd* —
`sessionArtifactPaths(sessionId, cwd)` encodes the cwd path, and for repo-backed
channels the cwd is the per-thread worktree that `processQueuedMessage()`
resolves via `ensureThreadWorktree()`. The session id likewise derives from the
logical folder the engine resolves (hot-reloaded config, worktree fallback to
`channelConfig.folder`). A drain-level hook that re-derives all of this in the
Slack adapter would duplicate the engine's resolution logic and drift from it.

So: thread an optional coordinator through the drain path, but have the engine
invoke it from inside `processQueuedMessage()` after cwd/worktree/session
resolution and immediately before the runner:

```ts
drainChannel(channelId, responderFactory, promptCoordinator?)

interface PromptCoordinator {
  /**
   * Called by the engine after it resolves cwd/worktree/session id, before
   * spawning Claude. `resuming` is the engine's session-artifact check for the
   * resolved (sessionId, cwd). Returns the rendered prompt text for this turn.
   */
  prepare(
    queued: QueuedMessage,
    session: { sessionId: string; resuming: boolean; cwd: string },
  ): Promise<{ text: string }>;
  /**
   * Called only after the runner resolves successfully. Advances the Slack
   * history watermark to the current message ts.
   */
  onTurnCommitted(queued: QueuedMessage, session: SessionInfo): Promise<void>;
}
```

`buildClaudeArgs()` / `buildPersistentClaudeArgs()` currently recompute the
artifact check themselves; expose that check (or pass the engine's precomputed
`resuming` down) so prompt rendering and `--resume` selection cannot disagree
within a turn.

For Slack, `prepare()`:

1. Load the Slack-history watermark for `session.sessionId`.
2. If `!resuming`, ignore any stale watermark: full prior thread context plus
   the new-session header.
3. Fetch Slack replies for the thread. When resuming with a watermark, pass
   `oldest=<watermark>` to `conversations.replies` so long threads don't
   re-fetch everything every turn.
4. Select only unseen Slack entries (rules in section 3).
5. Render and return the final prompt.

`onTurnCommitted()` advances the watermark to the current message `ts`. Failed
turns do NOT advance it: the unseen messages and the failed current message are
re-injected as unseen history on the next turn. If Claude did partially see them
before the error, that is benign duplication; advancing on failure would risk
silent loss instead.

Session-retry interaction: `withSessionRetry()` clears session artifacts and
retries once with a fresh `--session-id` when a session is "already in use".
That retried turn runs with a follow-up-style prompt against a brand-new session
— accept the one-turn degradation, but delete the watermark alongside
`clearSessionArtifacts()` so the *next* turn hits the "artifact but no
watermark → inject full prior thread once" recovery rule from section 3.

Voice and other adapters pass no coordinator. Legacy queue entries without a
`slack` payload skip `prepare()` and use their pre-rendered `text` as today.

Skip the Slack replies fetch when the current message starts the thread
(`ts === threadTs`) — there is nothing prior to fetch; the new-session header is
still emitted.

### 3. Track a per-session Slack history watermark

Create a small persistent state file under `DATA_DIR/slack-history/`, one file
per Claude session id (the session id already deterministically encodes
channel + logical folder + threadTs, and per-session files avoid write
contention between concurrently draining channels):

```json
{
  "sessionId": "...",
  "channelId": "C123",
  "threadTs": "1710000000.000100",
  "lastSeenSlackTs": "1710000123.000200"
}
```

Lifecycle:

- The engine supplies the session id (section 2); the adapter never derives it.
- Deleted whenever session artifacts are cleared (`clearSessionArtifacts()`
  path), so watermark state can never outlive the session it describes.
- Age-based GC at startup, like worktree GC. Deleting a stale watermark is safe:
  the worst case is the "artifact but no watermark" rule below, i.e. one
  redundant full-thread injection.

Selection rules:

- If there is no Claude session artifact, ignore any stale watermark and include
  the full prior Slack thread before the current message.
- If there is a session artifact and a watermark, include messages where
  `lastSeenSlackTs < message.ts < currentMessage.ts`.
- If there is a session artifact but no watermark, conservative fallback:
  include the full prior Slack thread once, then establish the watermark.
- Always include the current Slack message.
- On a **resumed** session, exclude Claudeway's own bot messages from injected
  history — Claude generated them and the session transcript already has them.
- On a **new** session (no artifact) over a thread the bot previously replied
  in, include the bot's own messages, labeled as the bot: the fresh transcript
  does not have them, and omitting them would show Claude a one-sided
  conversation. Edge case only — this occurs when the local session artifact
  was lost (Claude CLI transcript cleanup via `cleanupPeriodDays`,
  host/container rebuild without persisted `~/.claude`, artifacts cleared by
  `withSessionRetry()`), never in the normal flow. No new detection: branch on
  the engine-supplied `resuming` flag from section 2 — the existing
  `existsSync(sessionArtifactPaths(sessionId, cwd).jsonl)` check that already
  picks `--resume` vs `--session-id`.
- Include third-party bot messages as normal history entries, correctly labeled.
  Keep today's rule from `fetchThreadContext()`: only `user === botUserId`
  counts as "our" bot; keying on any `bot_id` would mislabel GitHub/Jira/CI
  bots as Claude's own words.
- Messages whose only content is a file attachment are currently dropped by
  `fetchThreadContext()` (`if (!text) continue`). Under the new format they
  must be included, rendering just the author prefix and the
  `{File attachment(s): ...}` metadata line.

Use a Slack timestamp helper rather than raw string comparison.

### 4. New prompt format

Example: first message in a Claude session. The thread header appears only here.
The context section may include full prior Slack thread context if the Slack
thread already had messages before Claudeway entered/resumed the session.

```text
=== Slack thread id: C123/1710000000.000100 ; Bot (you): <@UBOT> Claudeway ===

--- Slack context ---
[1710000100.000200 <@U111> Alice]: I pushed the fix.
[1710000110.000300 <@U222> Bob]: Can you check the logs?
{File attachment(s): name="logs.txt" id=F123 type=text/plain size=14 KB ref=slack-file:C123:1710000110.000300:F123}

[1710000120.000400 <@U333> Cara]: <@UBOT> please review that log
{File attachment(s): name="trace.json" id=F999 type=application/json size=41 KB ref=slack-file:C123:1710000120.000400:F999 path=/.../F999-trace.json}
```

Example: follow-up in an existing Claude session. No thread header; context is
only unseen Slack activity after the last processed Slack turn, if any.

```text
--- Slack context ---
[1710000130.000500 <@U222> Bob]: I added one more case while the bot was not tagged.

[1710000140.000600 <@U333> Cara]: <@UBOT> include Bob's note too
```

A no-context follow-up (the common case) renders as just the current message
line:

```text
[1710000140.000600 <@U333> Cara]: <@UBOT> include Bob's note too
```

Rules:

- Emit `=== Slack thread id: ... ; Bot (you): ... ===` only on a new Claude
  session.
- Emit `--- Slack context ---` when injecting prior Slack messages. On a new
  session this can be full initial thread context; on resumed sessions it is
  only unseen Slack activity since the stored watermark. Omit the section when
  there are no prior/unseen messages to inject.
- Do not emit a current-message id header. The current message is the final
  block and carries its own `[<ts> <@U...> Name]: text` prefix, so the ts is
  already present; the channel id lives in the new-session thread header (and
  the resumed session transcript). A no-context follow-up therefore renders as
  just the current message line. When prior context is injected, the blank line
  after the `--- Slack context ---` block separates it from the current message.
- Do not emit `[Slack user reference]` at all. Remove the old user-directory
  formatter/code path as part of the new prompt implementation; only already
  persisted legacy queue text may still contain it.
- Each history/current entry prefix carries the author Slack id and display
  name: `[<ts> <@U...> Name]: text`. When the display name cannot be resolved
  (missing `users:read` scope, API failure — the `canResolveUsers=false` path),
  degrade to the id-only prefix `[<ts> <@U...>]:` rather than repeating the id
  as the name.
- Attachment metadata is rendered as a separate curly-braced line:
  `{File attachment(s): ...}`. This keeps it visually separate from message
  prefixes, which use square brackets.
- Current-message attachments keep today's eager-download behavior: include both
  the opaque Slack ref and the downloaded local `path=...` in the attachment
  line so Claude can use its normal `Read` tool immediately.
- Prior-thread attachments include metadata and opaque refs only in Phase 1; no
  local path is shown until a later fetch helper downloads the file.
- Bypass the generic `buildMessageWithFiles()` footer for new Slack prompts so
  attachment information is not duplicated. Concretely: the runners append the
  footer from `queued.filePaths` (`buildClaudeArgs()` and the persistent stdin
  path), and voice still needs it — so gate on the structured payload
  (skip the footer when the message was rendered via `prepare()`), rather than
  dropping `filePaths` from the queue entry.
- Update the engine's console-log stripping (`logText` in
  `processQueuedMessage()`), which regex-strips the old `[... reference]` /
  `[Thread context ...]` headers. With rendering moved to processing time the
  engine can log the raw text from the structured payload directly instead of
  stripping rendered headers.

### 5. Prior attachment refs and fetch-on-demand

Phase 1 should add metadata refs only:

```text
{File attachment(s): name="report.pdf" id=F123 type=application/pdf size=2.1 MB ref=slack-file:C123:171...:F123 ; name="logs.txt" id=F124 type=text/plain size=14 KB ref=slack-file:C123:171...:F124}
```

Separate multiple files with ` ; ` so the agent can scan each attachment as a
distinct item.

For files attached to the current tagged message, the same line includes the
downloaded local path:

```text
{File attachment(s): name="trace.json" id=F999 type=application/json size=41 KB ref=slack-file:C123:171...:F999 path=/.../F999-trace.json}
```

Phase 2 should add an on-demand fetch tool. It does not have to be MCP-first:
the simplest viable shape may be a Claudeway-provided helper command/local tool
that takes the opaque Slack file ref or Slack file id, downloads the file, and
returns a local path for Claude's existing `Read` tool. Recommended constraints:

- Existing Claude `Read` is sufficient after the helper returns a local path.
  Current stock tools alone cannot fetch prior Slack private files from an id
  because the Slack token is intentionally not present in the Claude subprocess
  env.
- Expose `slack_fetch_file(ref)` or equivalent as a small tool/helper available
  to the Claude turn.
- The prompt only contains opaque refs, never Slack URLs.
- The tool validates that the ref belongs to a known message in the current
  Slack thread/session.
- The tool downloads the file using the gateway's Slack token outside the Claude
  subprocess env.
- The tool writes the file to the current request temp dir or thread scratch dir
  and returns a local path Claude can `Read`.
- Download size limits and audit logging should match current current-message
  attachment handling.

Pushback: do not pass Slack private download URLs or `SLACK_BOT_TOKEN` into
Claude. That defeats the existing env allowlist and makes token exfiltration
much easier.

### 6. Editing and deletion behavior

- Message edits should update raw Slack fields, not a pre-rendered prompt.
  `updateQueuedMessage()` currently replaces only `text` + overrides; extend it
  to write the re-parsed raw text into `slack.rawText` (and keep `text` in sync
  as the fallback) when the entry has a structured payload, while preserving
  today's behavior for legacy text-only entries.
- If a pending queued Slack message is edited, re-parse model/effort overrides
  and raw text as today, but leave history rendering to processing time.
- Message deletion should continue to remove pending queue entries.
- If a previously processed Slack message is edited, do not attempt to rewrite
  Claude session history. Treat it as Slack-only history drift; the next prompt
  can include the edited message only if it is still after the watermark and
  unseen.

### 7. Migration Path

1. Extend thread types to carry Slack ids, message ts, author name, bot kind,
   attachment text, and file metadata (including file-only messages that are
   dropped today).
2. Add prompt-format helpers and tests for the new compact headers.
3. Add Slack history state (per-session files, timestamp comparison, GC,
   deletion on `clearSessionArtifacts()`).
4. Expose the engine's session resolution to the coordinator: pass
   `{ sessionId, resuming, cwd }` from `processQueuedMessage()` and make the
   runners consume the same `resuming` decision instead of re-checking.
5. Add the `PromptCoordinator` hook (prepare + onTurnCommitted) invoked from
   `processQueuedMessage()`, and move Slack prompt rendering from enqueue time
   to processing time in the same change as switching the handler to enqueue
   structured raw Slack turn data (no double-render window).
6. Keep legacy `QueuedMessage.text` fallback for old queue files; update
   `updateQueuedMessage()` for structured entries and the engine's `logText`
   stripping.
7. Add prior-attachment metadata refs and the `buildMessageWithFiles()` footer
   bypass for structured Slack messages.
8. Add optional on-demand fetch helper/tool as a second phase.
9. Remove the old `[Slack user reference]` / user-directory prompt path
   (`formatUserDirectory`, `resolveUserDirectory`, `formatThreadContext`,
   `buildPrompt`); keep only legacy queue fallback for already-rendered queued
   messages.

## Tests

- Prompt formatting:
  - first session includes `=== Slack thread id: ... ; Bot (you): ... ===`
  - follow-up turns do not include the Slack thread header
  - resume turn emits no user directory
  - injected prior messages use `--- Slack context ---` for both initial full
    context and resumed unseen context
  - no current-message id header is emitted; the current message line carries
    the ts + sender prefix
  - a no-context follow-up renders as only the current message line
  - author prefix includes Slack id and display name
  - no `[Slack user reference]` block is emitted
  - block headers use the chosen dash/equals markers, not bracket-only headers
- History selection:
  - no session artifact → full prior thread
  - session artifact + watermark → only unseen entries
  - session artifact + no watermark → full prior thread once, watermark
    established
  - own bot messages excluded when resuming, included (labeled) on a new
    session over an existing thread
  - third-party bot messages included and not labeled as Claude
  - file-only messages (no text) appear as prefix + attachment metadata line
  - multiple queued messages render at processing time with updated watermarks
  - failed turn does not advance the watermark; the same messages are unseen
    on the next turn
  - session-retry (`withSessionRetry` fresh-session fallback) deletes the
    watermark so the following turn re-injects full thread context
  - resume check uses the engine-resolved cwd (worktree), not the logical
    folder path
- Queue/edit:
  - pending edit updates raw text and overrides
  - old queue entries with only `text` still process
- Attachments:
  - current-message files still become local paths
  - current-message attachment line includes both `ref=...` and `path=...`
  - prior-message files render metadata refs only
  - multiple file metadata entries are separated by ` ; `
  - oversized/non-downloadable prior files are represented accurately
  - fetch tool rejects unknown/cross-thread refs

## Decisions

1. Slack thread header appears only on a new Claude session. No current-message
   id header is emitted — the ts is in the message prefix and the channel id in
   the thread header / resumed transcript.
2. Phase 1 includes prior-file metadata refs only; on-demand fetching is Phase 2.
3. Claudeway's own bot messages are not injected into Slack history when
   resuming; on a new Claude session over an existing thread (artifact-loss
   edge case) they are injected, labeled as the bot, reusing the existing
   `resuming` check.
4. The prompt-preparation hook is invoked by the engine inside
   `processQueuedMessage()` after cwd/worktree/session resolution — the adapter
   never derives session ids or artifact paths itself, because artifact paths
   encode the resolved worktree cwd.
5. The watermark advances only after a successful runner completion. Failed
   turns re-inject; duplication is preferred over loss.
6. Watermark state is keyed by Claude session id, one file per session under
   `DATA_DIR/slack-history/`, deleted with session artifacts and GC'd by age.
7. No double-render migration window: the handler switches to structured
   enqueue in the same change that moves rendering to processing time; `text`
   on structured entries holds raw text only.
