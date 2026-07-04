# Codebase review findings

Date: 2026-07-04
Status: implemented (2026-07-04) — all High + Medium + test gates done; most Low
done. Intentionally deferred: the two large refactors below (except the chunker
unification, which shipped as part of #6) and three cosmetic Low items noted
inline.

Whole-`src/` review (~9k non-test lines) across six subsystems: Claude
orchestration, config/credentials/secrets, Slack adapter (commands +
streaming), voice adapter + core, lifecycle/sync/creds-form. Severities are
post-verification against source. Items are grouped by priority; each has a
file:line anchor and a fix sketch. Check off as addressed.

## High — correctness / availability

- [x] **1. Process-slot / queue cleanup leak → global deadlock** —
  `src/core/engine.ts:143-236`. The message is marked processing and
  `acquireProcessSlot()` runs before the try/finally that releases it (try
  starts at `:236`). A throw from `createRequestTempDir` (`:182`) or
  worktree/prompt setup skips `releaseProcessSlot()`, `processingMessages.delete`
  and `dequeue()`. The queue item remains on disk; each later drain can leak
  another of 8 slots until every channel blocks. **Fix:** open the guarded
  cleanup region before any fallible setup after `processingMessages.add`, track
  `slotAcquired` and nullable `tempDir`, and only clean up resources that were
  actually created. Add a regression where temp/worktree setup throws and a
  later drain still makes progress.

- [x] **2. One bad repo crashes the bot on startup** — `src/sync-repos.ts:23-28`.
  The clone path is not wrapped in try/catch (the update path is), and
  `syncRepos()` is called unguarded at `src/index.ts:103`. Bad URL / revoked
  auth (hangs to the 120s `execSync` timeout) / bad branch kills the process
  before any adapter starts. **Fix:** wrap the clone branch like the update
  branch; switch git calls to `execFileSync('git', args, ...)`; pass
  `GIT_TERMINAL_PROMPT=0` so auth prompts fail fast instead of hanging.

- [x] **3. Startup/shutdown SIGKILLs in-flight work, host-wide** —
  `src/index.ts:39-72`. `killOrphanProcesses()` uses
  `pkill -9 -f "claude.*dangerously-skip-permissions"` on both startup and
  shutdown — no SIGTERM grace, and it matches processes across the whole host
  (other Claudeway instances / interactive Claude sessions). Graceful machinery
  already exists but is unused (`killAllProcesses`/`killAndWait`,
  `src/claude.ts:195,1366`). **Fix:** track/kill only this instance's owned
  children (or process group), send graceful termination first, and reserve
  SIGKILL for owned processes that miss the grace window.

- [x] **4. Voice `finish()` ignores failure outcome** —
  `src/adapters/voice/responder.ts:101`. `finish()` takes no args, dropping the
  `StreamOutcome` from `src/core/interfaces.ts:28`. On a mid-turn crash the
  engine sends `{type:'error'}` then `finish({ok:false})`, but `finish` only
  early-returns on `aborted`/`ttsFailed` — so it speaks partial audio and sends
  `response_audio_end` as success. **Fix:** short-circuit on
  `outcome?.ok === false`.

- [x] **5. Streaming answer silently truncated** —
  `src/adapters/slack/responder.ts:92-96`. Live `flush()` truncates on
  post-conversion length (`markdownToSlackMrkdwn(...).length`, inflated by link
  conversion); `onStreamComplete` decides whether to rebuild on **raw**
  `finalText.length`. Raw-under / converted-over → the `_[streaming...]_`
  message is never rebuilt and the answer stays cut off. **Fix:** compare the
  same (converted) length in both places.

## Medium

- [x] **6. Broken code fences when splitting messages** —
  `src/adapters/slack/delivery.ts:41-65,85-100` + `formatting.ts:280-296`.
  Three chunkers split on char count with no fence-parity tracking
  (`buildDetailsContainer` uses a raw `slice(i,i+2900)` with no newline/word/
  surrogate awareness). Code blocks straddling a boundary render as unclosed
  fences; a boundary inside a 2-unit emoji corrupts the glyph. **Fix:** one
  shared fence-aware chunker, introduced behind golden tests for code fences,
  Slack mrkdwn links, details containers, and surrogate pairs.

- [x] **7. MCP read-only config write race** — `src/mcp.ts:47-49`. Concurrent
  spawns with the same read-only server set share `destPath + '.tmp'`; the
  loser's `renameSync` throws ENOENT → spawn fails. **Fix:** unique tmp suffix.

- [x] **8. Git credential helper answers for any host** —
  `src/git-credentials.ts:59-73`. The helper returns the GitHub PAT on `get`
  regardless of host (only the URL rewrite is github-scoped) → token leaks to
  any other HTTPS remote the agent contacts. **Fix:** scope to
  `[credential "https://github.com"]`.

- [x] **9. Unauthenticated DoS on the creds form** —
  `src/adapters/creds/index.ts:19-45`. Rate limiter is a process-wide global
  (not per-IP) and any invalid/expired token trips it → 3 anonymous requests
  lock every enrollee out for 5 min. Server also hardcodes `0.0.0.0` with no
  `host` option. **Fix:** key the limiter by IP (or only count failed POSTs
  with well-formed tokens); add a `credsForm.host` config option.

- [x] **10. Pidfile lock not atomic (TOCTOU)** — `src/index.ts:17-29`.
  `existsSync`→`kill(0)`→`writeFileSync` lets two racing launches both acquire.
  **Fix:** `writeFileSync(PIDFILE, pid, { flag: 'wx' })`.

- [x] **11. Fatal startup/runtime errors only log, leaving process state
  ambiguous** — `src/index.ts:71-103,94-99`. Startup work runs after the
  pidfile is written, but failures before `process.on('exit', releaseLock)` can
  leak the pidfile; later `uncaughtException` / `unhandledRejection` handlers
  only log and keep a potentially corrupted process alive. **Fix:** install exit
  cleanup before fallible startup checks and decide a fatal-error policy
  (graceful shutdown/fail-fast) instead of continuing after unknown state.

- [x] **12. Third-party bot messages attributed to Claude** —
  `src/adapters/slack/thread.ts:77`. `isBot = !!m.bot_id || m.user === botUserId`
  labels any bot's thread message (GitHub/Jira/CI) as Claude's own, feeding the
  model false "I said this" context. **Fix:** key on `m.user === botUserId`.

- [x] **13. `botOwnerSlackIds` fabricates a fake Slack id** —
  `src/config.ts:120-124`. Falls back to the raw registry key when an owner has
  no `slack:` field → `<@owner>` renders as literal text and
  `conversations.open({users:'owner'})` fails silently (owner DMs never
  arrive). **Fix:** filter to Slack-id-shaped values; warn at config load.

- [x] **14. Unbounded concurrent voice recordings** —
  `src/adapters/voice/handler.ts:271-294`. Only duplicate `requestId` is
  rejected; distinct recordings without `audio_end` buffer ~3.84MB each until
  disconnect. **Fix:** cap concurrent recordings / total buffered bytes.

- [x] **15. TTS socket close never surfaced as error** —
  `src/core/voice-deepgram.ts:197-202`. `onclose` never calls `errorHandler`, so
  an unexpected drop stops audio while the client is told the turn succeeded.
  **Fix:** fire `errorHandler` when `!this.closed`.

- [x] **16. Duplicate/orphaned streaming messages** —
  `src/adapters/slack/responder.ts:85-152`. `flush()`/`onToolEvent` lack the
  re-entrancy guard `SlackTurnStream` has; a `postMessage` slower than the
  500ms interval appears capable of posting two messages (one orphaned).
  `onToolEvent` also lacks a `finished` check → a late event can re-create the
  deleted status message. **Fix:** first add a latency/re-entrancy regression
  that proves the duplicate/orphan behavior, then add in-flight + `finished`
  guards.

- [x] **17. LIFO tool-completion mis-attribution** —
  `src/adapters/slack/thinking-steps.ts:149-170`. `complete` matches the
  innermost open call by `toolName` only; parallel same-name calls finishing
  out of order label the wrong card. **Fix:** carry the stream content-block
  index/id into `ToolEventPayload` and match completions on that stable key.

- [x] **18. Persistent processes have no absolute timeout** —
  `src/claude.ts:1148-1279`. Only an idle timer, which output resets forever
  (one-shot streaming has `ABSOLUTE_TIMEOUT_MS`, `:821`). **Fix:** add the same
  12h cap.

- [x] **19. Permanent Slack errors retried every flush tick** —
  `src/adapters/slack/stream.ts:243-256`. Non-transient errors (missing scope,
  `channel_not_found`) retry indefinitely for the turn, draining the shared
  append budget and degrading other channels. **Fix:** classify permanent
  errors and stop.

## Test coverage gates

- [x] `#1` — simulate failure before runner startup and assert the queue item,
  processing marker, temp dir (if created), and process slot are cleaned up.
- [x] `#4` — voice streaming failure must emit the error and must not speak
  buffered partial text or send `response_audio_end`.
- [x] `#5` — raw-under / mrkdwn-over Slack response must rebuild through final
  delivery instead of leaving `_[streaming...]_`.
- [x] `#7` — concurrent read-only MCP config generation with the same server
  set must not throw or leave a partial config.
- [x] `#16` — slow Slack `postMessage`/`update` promises must not create
  duplicate live messages or resurrect status after finish.

## Low / dead code

- [x] `src/queue.ts:34` — `ts.replace('.', '-')` replaces only the first dot;
  latent filename collision for multi-dot ts. Use `replaceAll`. **Done.**
- [x] `src/secrets.ts:112` — `typeof parsed.users !== 'object'` passes for
  `null`; add an explicit null guard. **Done.**
- [x] `src/claude.ts:509,558` — `channelId` threaded through
  `AllowedEnvContext`/`resolveExposedEnvVarNames` but never read. Dead param.
  **Done** — removed from `AllowedEnvContext`, `resolveExposedEnvVarNames`, and
  `processIdentityKey` (+ all call sites and `env-allowlist` tests).
- [x] `src/claude.ts:549,872` — HOME fallback hardcodes `/Users/${USER}`
  (macOS); wrong on Linux/Docker. **Done** — falls back to `os.homedir()`.
- [x] `src/core/prose-chunker.ts:217-224` — decimal-skip branch is unreachable
  because the outer sentence-boundary condition already requires whitespace
  after punctuation. **Done** — removed the dead branch (decimals are already
  never boundaries since the char after the dot is a digit, not whitespace);
  left an explanatory comment.
- [x] `src/core/voice-deepgram.ts:13,18` — `DeepgramClient` constructed but
  never used (`transcribe` uses raw `fetch`). Remove field + import. **Done.**
- [x] `src/adapters/voice/responder.ts:146-152,333` + `voice-deepgram.ts:288` —
  `getKillProcess`/`isAborted`/`getStreamingResponder`/`abort()` have no callers.
  **Done** — removed the three responder methods. `abort()` KEPT: it is exercised
  by `voice-deepgram-tts.test.ts`, so it is not actually dead.
- [~] `src/config.ts:277-289` (`resolveGlobalPermissions`) and `:673-686`
  (`resolvedDmConfig.triggerMode`) — exported/computed but never consumed in
  production. **Partly done:** `resolvedDmConfig.triggerMode` now hardcodes
  `'all'` (a DM is inherently directed at the bot and always triggers; reading
  `defaults.triggerMode` falsely implied it applied). `resolveGlobalPermissions`
  is LEFT: it is a coherent, test-covered permission-resolution utility and
  "delete vs. wire into the DM permission path" is a design decision, not
  cosmetic cleanup.
- [ ] `src/adapters/slack/delivery.ts:17` — `CONTAINER_MAX_CHILDREN=10`
  unreachable given `DETAILS_MAX_CHARS=7000`. **Skipped:** kept as a defensive
  cap on the (now `chunkText`-based) child count.

## Refactors (defer until targeted fixes land)

- [~] **Split `src/claude.ts`** — PARTIALLY DONE (1517 → 1107 lines). Extracted
  the two well-tested, cohesive jobs and de-duplicated the retry wrapper:
  - `src/claude-stream-parser.ts` — NDJSON parsing (`parseStreamLine`,
    `extractKeyArg`, `ToolEventPayload`/`StreamLineEvent`/`ToolAccumulator`);
    covered by `ndjson.test.ts`. `claude.ts` re-exports for import compat.
  - `src/claude-spawn-env.ts` — the env allowlist + git enforcement + spawn env
    assembly + `processIdentityKey`; covered by `env-allowlist.test.ts`.
    Imports `ClaudeOptions` type-only, so no runtime cycle.
  - Factored the duplicated "`already in use` → clear → retry" wrapper into
    `withSessionRetry()`, shared by the oneshot and streaming runners.

  **Still deferred:** extracting the persistent-process runner
  (`createPersistentProcess`/`runClaudePersistentStreaming` + the registries and
  `killProcess`/`nudgeProcess`/`getActiveProcesses` that share them). This is the
  piece the plan gates on characterization tests — it has NO runtime test
  coverage and a clean cut needs a shared `claude-registry.ts` (+ likely a
  `claude-session.ts`) to avoid a claude↔persistent import cycle. Doing it blind
  risks the subprocess lifecycle; leave it until those characterization tests
  exist.
- [x] **Unify the three text chunkers** into one fence-aware splitter (fixes #6
  in one place instead of three). **Done** as part of #6 — `chunkText()` in
  `formatting.ts` now backs `splitMessage`, `mrkdwnSections`, and
  `buildDetailsContainer`, with golden tests for fences and surrogate pairs.

## Post-implementation review follow-ups (2026-07-04)

A second review of the implementation found three residual gaps; all fixed:

- [x] **#6 residual** — `chunkText()` could emit an over-limit chunk when the
  fence-reopen prefix (`'```lang\n'`) was added *after* the fit check: the
  overflow test ran pre-emit, then the line was appended to a continuation
  chunk whose prefix pushed it past `maxLen`. Fixed by re-checking (and
  hard-splitting if needed) against the post-emit `reopenPrefix`; `emit()` also
  no longer emits a bare-prefix chunk. Regression:
  `chunkText('```ts\n' + 'x'.repeat(3891) + '\n```', 3900)`.
- [x] **#17 residual** — both runners kept a single `toolAccum`, so a tool
  block starting before the previous one stopped overwrote it and dropped the
  first completion (the index-matched fix only covered the UI layer). Replaced
  with `ToolUseAccumulators` (per-index map, `claude-stream-parser.ts`), used
  by the oneshot and persistent runners; unit-tested with interleaved blocks.
- [x] **#16 residual** — `StreamingResponder.onToolEvent` had no in-flight
  guard: two quick tool events could both see `statusTs === null` and both
  post (one bubble orphaned). Status posts/updates are now serialized through
  a `statusOp` promise chain that `finish()` awaits before deleting, which
  also replaces the old post-hoc orphan cleanup. Regression tests cover the
  slow-post duplicate and finish-during-in-flight-post cases.

## Verified sound (not findings)

- Native-stream keepalive timers do not leak — `engine.ts` always calls
  `sr.finish({ok:false})` in a `finally`, and both timers clear synchronously
  before any `await`.
- Slack magic-command authorization scoping (`!ps`/`!kill`/`!config`/`!creds`)
  is correctly enforced against Bolt-verified ids.
- Magic-link single-use/TTL and creds-form HTML escaping are clean; no XSS or
  path-traversal surface in the creds routes.
