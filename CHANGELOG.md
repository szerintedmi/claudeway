# Changelog

## [0.37.1] - 2026-07-06

### Changed
- **Claude enrollment hints now name `claude setup-token`**: the unenrolled-user refusal and the `!creds` DM link reply tell users to run `claude setup-token` up front, instead of only revealing it once they reach the web form

## [0.37.0] - 2026-07-06

### Fixed
- **Slack attachments posted in earlier thread messages are now downloaded** (closes the Phase-2 gap noted under 0.34.0): a file shared in one message and then referenced by a later `@mention` was invisible to Claude — only the triggering message's files were fetched, so `incoming/` stayed empty and the file could not be read. `conversations.replies` already returns each context file's `url_private_download`, which is now preserved as a server-side `downloadRef` (`collectFileMeta`, `src/adapters/slack/thread.ts`) and downloaded into the session's `incoming/` alongside current-message files (`resolveContextFiles`, `src/adapters/slack/coordinator.ts`), rendered with a `path=` like any other attachment. Volume is bounded by the history watermark (resumed sessions only re-scan unseen messages) and a skip-if-exists guard so a file downloads at most once; context-file failures surface as distinct thread warnings ("referenced in earlier messages"). The download URL stays server-side, never in the prompt or subprocess env

## [0.36.0] - 2026-07-05

### Changed
- **Docker git auth is PAT-only over HTTPS**: startup repo sync uses the shared GitHub PAT (`SHARED_GITHUB_TOKEN` via the `github` `userCredentials` mapping) through the SSH→HTTPS credential helper. Removed the SSH key mount, `GIT_SSH_KEY`, and the Dockerfile `~/.ssh` setup
- **Docker image cleanup**: dropped the vestigial `git credential.helper store` config and the no-op `docker-entrypoint.sh` (repo sync runs in-app); pruned stale `.dockerignore` entries and excluded `.docker/` from the build context

## [0.35.0] - 2026-07-04

### Changed
- **Temp directories consolidated into one per-session working dir** (`docs/plans/2026-07-04-temp-dir-consolidation.md`). Inbound downloads, files Claude generates, generic tool temp, and the outbound attachment manifest now all live under `<tempDir>/<channelId>/<sessionId>/`, keyed by the resolved Claude session id (1:1 with the transcript). Everything persists across turns within a session — Claude can re-read files people sent it and files it generated, by path, in any later turn — and a single age-based GC (`cleanupStaleTempDirs`, `tempMaxAgeDays`) reclaims the whole tree using a `.last-used` marker so active text-only sessions aren't reaped
  - **One env var**: `CLAUDEWAY_TEMP_DIR` is the session dir and `TMPDIR` points at its `tmp/` subfolder, so generic tool temp (`mktemp`, Python `tempfile`, …) lands inside the managed tree instead of leaking to `/tmp`. Retired `CLAUDEWAY_SCRATCH_DIR`, `CLAUDEWAY_TEMP_BASE`, and the `<channelId>.current` pointer file (persistent mode now sets the fixed session dir once at spawn)
  - **Slack downloads deferred to processing time**, keyed by the resolved session, so a channel `folder`/`repo` change while a message is queued no longer orphans downloads under a stale session id; failed/oversized downloads surface as thread warnings instead of throwing or being silently dropped. The download reference stays server-side on the queue entry, never in the prompt or subprocess env
  - **Persistent process respawns on a session-id change** (not just an identity change), so a mid-thread folder change tracks the new cwd/env/temp dir and drains attachments from the correct session dir
  - **Docker**: the temp base (`.claudeway-tmp`) is now bind-mounted so per-session files survive container recreation (matching the old `.docker/files` behaviour). Trade-off: `$TMPDIR` leaves the 100 MB `/tmp` tmpfs and lands on disk under the mount
  - **Migration**: old stores (`.docker/files/`, `.claudeway-tmp/req-*`, `.claudeway-tmp/*.current`, `.claudeway-tmp/scratch/`) are no longer written but linger; delete them by hand once (see `docs/troubleshooting.md`). No automatic sweep. In-flight persistent processes keep their old dirs until their next natural respawn

## [0.34.1] - 2026-07-04

### Fixed
- **Redundant "Work log" box on plain answers (Slack `stream-native`)**: a turn with no tool calls, narration, or surfaced reasoning left just a bare "Thinking" card in the work-log box above the answer. The box is now stripped at finish when the log never grew past that seed card — the answer stands alone. `TaskTracker.isTrivial()` drives both the in-place rebuild and the block rebuild (`toBlocks()` returns nothing for a trivial log), so a bare-Thinking box is dropped on clean, broken-stream, and details-fold paths alike

## [0.34.0] - 2026-07-04

### Changed
- **Slack history injection reworked** to stop re-sending context Claude already has. Resumed sessions inject only unseen thread messages via per-Claude-session history watermarks (`src/slack-history.ts`); prior tagged turns already live in Claude's transcript through the deterministic session id, so the old whole-thread re-injection every turn was redundant. Each message prefix now carries Slack metadata (channel id, thread ts, message ts, author id + display name) so Claude can cite exact messages, and prior-thread attachments contribute file metadata without eagerly downloading every file
- **Removed the per-turn `[Slack user reference]` block**: the bot identity now rides the one-time new-session thread header instead of repeating every sender mapping each turn
- **Slack prompt/coordinator extracted** from the handler into `src/adapters/slack/prompt.ts` and `src/adapters/slack/coordinator.ts`. Slack tokens and private download URLs stay out of prompts and the Claude subprocess env; queue/edit/restart behavior preserved
  - Plan: `docs/plans/2026-07-04-slack-history-injection-rework.md` (Phase 2 on-demand file-fetch tool not started)

## [0.33.0] - 2026-07-04

### Fixed
- **Codebase review hardening sweep** (all High/Medium findings in `docs/plans/2026-07-04-codebase-review-findings.md` + follow-up review): engine process-slot/queue cleanup leak that could deadlock all channels; one bad repo no longer crashes startup; graceful instance-scoped child termination instead of host-wide `pkill -9`; voice `finish()` honors failure outcome; truncated streamed Slack answers now rebuilt; one shared fence-aware, surrogate-safe, length-safe Slack chunker (no broken code fences, split emoji, or over-limit chunks); MCP read-only config write race; git credential helper scoped to github.com; creds-form rate limiting per-IP (+ `credsForm.host` option); atomic pidfile lock; third-party bot messages no longer attributed to Claude; tool cards matched by content-block index and overlapping tool blocks accumulated per-index; 12h absolute timeout for persistent processes; permanent Slack errors stop retrying; duplicate/orphaned streaming status messages serialized

### Changed
- **`claude.ts` split** (1517 → ~1100 lines): NDJSON parsing → `claude-stream-parser.ts`, spawn env assembly → `claude-spawn-env.ts`, owned-child tracking → `child-processes.ts`; assorted dead-code removal

## [0.32.0] - 2026-07-03

### Added
- **Per-user credentials (BYO)**: collaborators can run the bot with **their own** Claude subscription and provider tokens instead of a shared account. People are defined once in a top-level `users:` registry (canonical id → name, Slack id, voice id) and referenced by channels via `members:`; the canonical id keys the secret store, audit log, and persistent-process identity across a person's Slack and voice identities. Downstream git/Jira actions run under and are attributed to their own accounts
  - **`!creds` enrollment**: a DM-only magic command issues a single-use, short-TTL magic link to a rate-limited web form (`src/adapters/creds/`) where users submit their own tokens; `!creds list`/`!creds revoke` (and per-credential delete checkboxes on the form) manage them
  - **Encrypted secret store**: AES-256-GCM per-user store in `.secrets/user-credentials.json` behind a `SecretStore` interface; requires a master key (`CLAUDEWAY_SECRETS_KEY` or `.secrets/key`)
  - **Config-driven resolution**: `userCredentials` defines fields, form labels/guidance, explicit shared defaults (`defaultFromEnv`), and delivery via `exposeAs` (`env` or `git-credential-helper`). Precedence is **personal secret > explicit shared default > unset** — no ambient fallback from matching env-var names
  - **BYO Claude always on**: the `claude` credential is injected automatically and personal enrollment is mandatory for everyone (bot owner included); unenrolled turns are refused with a `!creds` hint and audited as `spawn.denied`. Hard startup requirements: a secrets master key and `baseUrl`
  - **Git credential adapter**: `exposeAs: git-credential-helper` uses a per-spawn gitconfig (SSH→HTTPS rewrite + credential helper) so tokens stay out of the subprocess env; commits attributed to the registry name / Slack profile
  - **Append-only audit log**: every credentialed spawn and enrollment event lands in `.claudeway-audit.jsonl` (credential names, never values); decrypted values are scrubbed from stderr logs and error replies
- **Shared-credential guardrails**: a "Credential status" system-prompt block tells the agent which credentials are shared or absent (via `userCredentials.<name>.sharedAccessNote`) so it refuses doomed writes and points at `!creds` preemptively instead of failing mid-task. Where tokens can't be scoped (Atlassian), `userCredentials.<name>.mcpReadOnlyServers` forces the listed MCP servers read-only (`READ_ONLY_MODE=true` in a generated per-set config) whenever the credential isn't a personal secret; personal enrollment lifts it, and in persistent mode the read-only server set is part of the process identity key so enrolling mid-thread respawns the process
- **Per-thread git worktrees**: repo-backed channels run each Slack thread in its own worktree (`wt/<channel>/<threadTs>`) — thread participants share files, concurrent threads stay isolated, session IDs keep deriving from the logical repo folder. New worktrees are based on `origin/<branch>` after a throttled fetch (max once per 5 min/repo; falls back to local HEAD when offline). Startup GC keeps worktrees holding uncommitted or unmerged work regardless of age
- **Slack "Work log" via native Thinking Steps** (`stream-native`): tool calls, sub-agent progress, and reasoning bursts render as live task cards grouped in one collapsible "Work log" box — followable while generating, collapsed when done. Assistant text emitted *between* tool calls is classified into the work log as step cards (one line per narrated step) instead of polluting the answer
- **Slack inline "Details" fold** (`stream-native`): the `---DETAILS---` section streams live under an inline "Details" divider, then folds into a collapsed native `container` block inside the answer at finish (`batch`/`stream-update` fold the same way)

### Changed
- **`--strict-mcp-config` on spawned subprocesses**: gateway-spawned Claude sessions no longer load the operator's `~/.claude.json` MCP servers (and embedded personal credentials) — only the gateway-provided `--mcp-config` is honored, so per-user credential resolution isn't bypassed
- **Slack streaming responder rewritten** around Thinking Steps: one streamed message per turn, an ordered chunk queue with a shared rate-limit bucket, idempotent keepalive, and pure `TaskTracker`/`DetailsGate` state machines; delivery consolidated into a single `deliverText()` (upload/split/update/post + bounded retries). Removed the old two-stream + legacy-attachment collapse hack
- **`users:` registry migration**: the legacy `allowedUsers` config shape is now rejected at load with a migration hint
- **README rewritten** to a focused quick start; deep reference split into `docs/configuration.md`, `docs/deployment.md`, `docs/troubleshooting.md`, and `docs/per-user-credentials.md`. Added a Slack app manifest (`slack-app-manifest.example.yaml`) and a Cloudflare tunnel + `caffeinate` local-run recipe
- **`bun test` scoped to `src/`** (package.json, Makefile, pre-commit) so test files from synced `.docker/repos` clones can't leak into runs
- **Dependency updates**: `@deepgram/sdk` 5.4→5.5, `uuid` 14.0.0→14.0.1, TypeScript 5.9→6.0, plus ESLint/Prettier/typescript-eslint/lint-staged dev bumps
- **Config cleanup**: dropped dead `systemChannel` from `config.example.yaml`; renamed `GLASSES_AUTH_TOKEN` → `VOICE_AUTH_TOKEN` in `.env.example` to match config interpolation

### Fixed
- **Work log stuck expanded after errors/timeouts**: `IStreamingResponder.finish(outcome)` is now called on every path — a failed/killed turn flips open task cards to error state and still finalizes the stream
- **Live "ReadingReadingReading" duplication**: `task_update` details/output are append-only on the Slack wire, so the responder emits field deltas only (keeping a capped accumulated copy for block rebuilds)
- **Empty submodule dirs in thread worktrees**: `git worktree add` doesn't recurse into submodules, so new worktrees exposed empty gitlink paths. Unpopulated submodules are now replaced with relative read-only symlinks to the main synced checkout (marked read-only in a system-prompt note); populated or locally-edited submodules are never touched, and broken/dangling links self-heal on reuse. `syncRepos` keeps the main checkout's submodules on full history so shared blame/log/diff work
- **Overlapping persistent-mode turns**: the single-turn slot now rejects loudly instead of silently orphaning the previous turn's promise
- **Worktree git isolation**: worktree `git()` calls strip inherited `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` so ambient git context (e.g. a git hook) can't redirect worktree operations

## [0.31.0] - 2026-06-28

### Added
- **Collapsible "Details" section (Slack)**: responses can now lead with a concise TL;DR and fold the deeper explanation into an expandable "📋 Details" attachment below the answer, the same way the work log collapses (Slack auto-hides it behind "Show more…" once it's long enough). Claude marks the split with a `---DETAILS---` line; the server strips the marker, keeps the TL;DR in the answer bubble, and posts everything after it as the attachment. Works in all delivery modes (`batch`, `stream-update`, `stream-native`); oversized responses that upload as a file are left unfolded. The default `systemPrompt` instructs Claude to lead with a TL;DR and use the marker only when a detail section adds value

### Changed
- **Renamed "Working notes" → "Work log"**: the live reasoning/tool-activity stream and its collapsed attachment are now labelled "🧠 Work log" (also reflected in `!config`). The `collapseWorkingNotes` config key is unchanged
- **Live streaming indicators (Slack)**: the bot's live streamed message now carries a `:partyparrot:` reaction while it streams, removed when the stream finishes — a "generating" indicator. In `stream-native` it sits on the work-log stream (the message live for the whole turn; the answer stream when there's no work log); in `stream-update` it sits on the response message. The live work-log header also shows the same `:partyparrot:` in place of the old "(updating live…)" text. Both are best-effort: a workspace without the custom emoji simply shows no indicator

## [0.30.1] - 2026-06-28

### Fixed
- **Slack links/mentions rendered as literal text**: the mrkdwn converter escaped every `<`, mangling the Slack-native tokens Claude emits — `<URL|label>` links (e.g. Jira tickets), `<@user>`, `<#channel>`, and `<!here>` showed up verbatim. `<` is now escaped only when it doesn't open a valid Slack token

## [0.30.0] - 2026-06-27

### Added
- **Live "Working notes" (Slack, `stream-native`)**: Claude's reasoning and a full log of its tool and sub-agent calls stream into a separate live "🧠 Working notes" message, keeping the final answer clean and readable instead of buried in a wall of reasoning text. Reasoning is captured from the CLI `stream-json` `thinking_delta` events; the answer streams in its own message and, on completion, the notes collapse into an expandable attachment above it
- **`collapseWorkingNotes` config**: per-channel and in `defaults`, toggles the working-notes treatment (default `true`). When off, the answer streams as the sole live output, tool activity shows as a single self-replacing status line, and reasoning is not shown. Surfaced in `!config` for `stream-native` channels

## [0.29.0] - 2026-06-11

### Added
- **Per-turn effort override**: start a Slack message with `!effort:<level>` (`low`, `medium`, `high`, `xhigh`, `max`) to run just that message at a different thinking-effort level. Per-turn only — the next message reverts to the channel/default effort. Combines with `!model:` in any order, and override prefixes compose with magic commands (`!effort:high !kill` still executes the kill). The value is validated against the known set; an unrecognized level is rejected in-thread with the valid list (the CLI would otherwise silently run at the default effort) — validation replies are only sent after the channel-config/trigger/authorization gates, so the bot never replies where it would otherwise stay silent. Editing a still-queued message re-parses the prefix; an invalid effort in an edit applies the rest of the edit without the override and warns. Persistent sessions respawn with `--resume`, preserving context. The `xhigh` level was added to `EffortLevel` to match the current CLI
- **Config effort validation**: `effort` values in `config.yaml` (defaults and per-channel) are validated against the known levels at load time — a typo fails loudly instead of silently running at the CLI default effort. The engine also ignores unknown effort overrides read back from queue files

## [0.28.0] - 2026-06-09

### Added
- **Per-turn model override**: start a Slack message with `!model:<name>` (e.g. `!model:opus refactor this`, `!model:claude-opus-4-8 deep review`) to run just that message with a different model. Per-turn only — the next message reverts to the channel/default model. The name is passed straight to `claude --model` (no validation), so full versioned model IDs work and CLI errors are reported in the thread. Editing a still-queued message re-parses the prefix; persistent sessions transparently respawn with `--resume`, preserving conversation context

### Fixed
- **Persistent-mode errors now include stderr**: when a persistent Claude process exits non-zero, the in-thread error includes the turn's stderr tail instead of just the exit code

## [0.27.1] - 2026-06-07

### Fixed
- **No-op `READ_ONLY_MODE` on remote MCP servers**: `mcp-readonly.json` only injects the flag into stdio servers now — `http`/`sse` servers (e.g. New Relic) have no subprocess to read env, so the flag was meaningless noise

## [0.27.0] - 2026-06-07

### Added
- **`uv`/`uvx` in Docker image**: installed to `/usr/local/bin` so MCP servers that run via `uvx` (e.g. `mcp-atlassian`) work inside the container
- **Fail-fast bind mounts**: `config.yaml`, `mcp.json`, and the git SSH key now use long-form binds with `create_host_path: false`, so a missing source file stops the container from starting instead of silently creating a directory at the host path (which then broke the app at runtime)
- **Android dependency-update check**: added the `com.github.ben-manes.versions` Gradle plugin for surfacing outdated dependencies

### Changed
- **Server dependency updates**: `@deepgram/sdk` 5.0→5.4, `@slack/bolt` 4.6→4.7.3, `uuid` 13→14, `yaml` 2.8.2→2.9, plus ESLint/Prettier/typescript-eslint/`@types/bun` dev bumps
- **Android dependency updates**: OkHttp `5.0.0-alpha.14`→`5.3.2` (stable), Kotlin 2.3→2.4, coroutines 1.10.1→1.11, and MockK/Turbine/Robolectric/org-json bumps
- **Migrated lockfile from npm to bun**: removed `package-lock.json` in favor of `bun.lock`

### Fixed
- **OkHttp 5 stable nullability**: `Response.body` became non-nullable in the stable release, so the `4xx` error-body read in `ClaudewayWebSocket` no longer uses the `?.` safe-call (which is now a compile warning)

## [0.26.0] - 2026-06-07

### Fixed
- **stream-native mode lost the final Slack response on long tasks**: during long tool-execution gaps Slack finalized the streaming message, so updates stopped and no answer landed in the thread (despite the ✅). Native streaming now sends a periodic keepalive to hold the stream open, and always posts the complete response even if the stream expires anyway

### Changed
- More resilient native streaming: short replies show faster, transient Slack errors retry without duplicating text, and append rate stays within Slack's limit across concurrent channels

## [0.25.1] - 2026-05-08

### Fixed
- **MCP config not loading on recent Claude Code CLI**: Reordered `--mcp-config` to sit before `--dangerously-skip-permissions` instead of immediately before the positional user message. The CLI's `--mcp-config <configs...>` is variadic and was greedily consuming the trailing user message as a second config path, causing `Invalid MCP configuration: Failed to read file: Error: ENAMETOOLONG`. Reproduced on `claude` 2.1.123

## [0.25.0] - 2026-04-04

### Added
- **Unified permissions model**: Permission names are now config-defined in `permissions` section — each bundles env vars exposed to the Claude subprocess. `git` and `jiraWrite` are known names with built-in enforcement; custom names (e.g. `langfuse`) are env-var-only
- **Env var allowlist**: Claude subprocesses only see baseline vars (`HOME`, `PATH`, etc.) + global `env` + permission-linked env vars. Replaces the brittle 3-item denylist
- **Persistent process identity key**: Process restart comparison now includes user identity + resolved env exposure, fixing a bug where different users with the same permissions shared a process (leaking git author identity)

### Changed
- `UserPermissions` changed from `{ git: boolean; jiraWrite: boolean }` to `Set<string>` — permission names come from config, not a hardcoded enum
- `docker-compose.yml` uses explicit `environment:` entries instead of blanket `env_file: .env`

## [0.24.0] - 2026-04-04

### Added
- **Configurable temp file cleanup**: `tempMaxAgeDays` config option (default 90, 0 to disable) replaces hardcoded 24h cleanup. Covers Slack download files, orphaned request dirs, pointer files, and scratch dirs

### Fixed
- **Magic commands in mention mode**: `@bot !nudge` and similar commands now work in mention-trigger channels — bot mention prefix is stripped before matching command pattern

## [0.23.2] - 2026-03-31

### Added
- **Meta DAT SDK integration**: Reflection-based Meta Wearables DAT SDK (MWDAT v0.5.0) integration for glasses discovery — app compiles and runs with or without SDK on classpath
- **Volume-key push-to-talk**: Hardware volume-up key mapped to PTT toggle on Android, since DAT SDK does not expose touchpad gesture events

### Fixed
- **Slack file attachment previews**: Add `snippet_type` to `files.uploadV2` calls so text-based files (`.md`, `.py`, etc.) render with inline preview instead of showing as binary downloads

## [0.23.1] - 2026-03-29

### Added
- **Android companion app tests**: 105 tests across 7 classes (protocol snapshots, AudioRouter, AudioRecorder, ConversationSessionController, VoiceViewModel)
- **Glasses tap wiring**: GlassesManager touchpad tap events wired into VoiceViewModel push-to-talk toggle

## [0.23.0] - 2026-03-26

### Added
- **Slack shared/forwarded messages**: Messages shared via Slack's "Share message to channel" feature are now processed — extracts text and files from attachment payloads, fixes mention-mode gating, and includes shared message content in thread history context

## [0.22.0] - 2026-03-22

### Added
- **Voice channel**: WebSocket-based voice interface with provider-agnostic STT/TTS (Deepgram Nova-3 + Aura-2). Supports server-side, client-side, and local TTS modes
- **Android companion app**: Kotlin/Jetpack Compose app with push-to-talk and hands-free voice modes, Bluetooth SCO audio routing, barge-in support, and Meta glasses integration
- **Web voice test UI**: Browser-based voice interface with new chat, TTS mute, and audio device selector
- **Per-channel effort level**: `effort` config option (`low`, `medium`, `high`) in defaults or per channel to control Claude CLI thinking effort
- **Channel-agnostic engine**: Core message processing decoupled from Slack — enables multiple channel adapters (Slack, voice WebSocket)

### Fixed
- Bluetooth audio routing and SCO session management on Android
- Speech clipping on Android voice recording
- Soft keyboard covering text input on Android

## [0.21.0] - 2026-03-16

### Added
- **User roles & read-only default**: Per-user, per-channel permission system. Every user is read-only by default; permissions (`git`, `jiraWrite`) are additive via `allowedUsers` config
- **Multi-layer enforcement**: System prompt injection (soft), git credential stripping (hard), MCP read-only config generation (hard), git author identity from Slack profile
- **Per-channel scratch directory**: Persistent shared workspace at `.claudeway-tmp/scratch/<channelId>/` for read-only users to collaborate across messages
- **Persistent process permission tracking**: Process killed and respawned with `--resume` when incoming user's permission set differs from running process

### Changed
- `allowedUsers` config format extended from plain string array to mixed entries supporting permission mappings
- `botOwner` always has full access and can message any configured channel even without being listed in `allowedUsers`

## [0.20.0] - 2026-03-09

### Added
- **Slack mention resolution**: `<@U...>` mentions are kept intact in prompts with a name lookup header so Claude understands who's who and can mention people back. Gracefully degrades when `users:read` scope is unavailable.

## [0.19.0] - 2026-03-09

### Added
- **Docker skills injection**: `docker-skills.conf` lists global `~/.claude/` skill paths to sync into the Docker image via `--build-context`, keeping skills out of the repo

### Fixed
- **Mention trigger bypass**: `triggerMode: mention` was bypassed when files were attached without a text mention

## [0.18.0] - 2026-03-04

### Changed
- **Consolidated Docker state**: Persistent state (sessions, queue, repos) moved under `.docker/` directory
- **Repos sync on startup**: Configured repos are cloned/pulled every startup for both local and Docker

### Removed
- **`additionalRepos` channel config**: Unused option removed

## [0.17.0] - 2026-03-02

### Added
- **Docker containerization**: Full Docker support with `Dockerfile`, repo management, and persistent volume mounts
- **File attachments in Claude responses**: Claude can generate and upload files back to Slack threads
- **Upload failure warnings**: Slack thread warnings when file uploads fail

### Changed
- **Pinned Node.js 24** locally and in Docker
- **Session path encoding fix**: Corrected session artifact path display at startup

## [0.16.0] - 2026-03-01

### Added
- **Mention-only trigger mode**: `triggerMode: mention` — bot only responds when `@mentioned`, with full thread context injection so it understands the conversation
- **All file type attachments**: Generalized from images-only to support any file type (PDF, text, etc.)
- **Markitdown skill**: Built-in skill for converting documents to Markdown before sending to Claude
- **User-facing error warnings**: Silent failures now post warnings in Slack threads (e.g. failed thread history, file downloads)
- **Magic command authorization**: `botOwner` required for global commands, `allowedUsers` for channel-scoped ones

### Changed
- **Improved system prompt**: Added Slack mrkdwn formatting guide so Claude produces properly formatted responses
- **Completion reaction**: Changed from `:white_check_mark:` to `:ballot_box_with_check:`
- **Thread isolation fix**: Separate Claude sessions per thread within the same channel
- **Magic commands refactored** into a registry-based system

## [0.15.0] - 2026-02-28

### Added
- **Tool status streaming**: Shows which tools Claude is using in real-time during Slack message updates

### Changed
- **Migrated to Bun**: Replaced npm/tsx/jest with Bun runtime, bundler, and test runner

### Fixed
- **Stream-native mode**: Fixed duplicate chunks and failures in non-DM channels

## [0.14.0] - 2026-02-26

### Added
- **Per-channel `allowedUsers`**: Restrict which Slack users can interact with the bot per channel
- **YAML config**: Added `config.yaml` support, later standardized as the only config format (JSON dropped)
- **`!config` command**: View current channel configuration directly from Slack
- **DM support**: Bot responds to direct messages from `botOwner`

## [0.12.0] - 2026-02-23

### Added
- **Message edit detection**: Editing a queued Slack message (📥) updates the queue content with the new text before it's processed. If the message is already being processed (⏳), the edit is ignored — the in-flight request uses the original text.

## [0.11.0] - 2026-02-23

### Added
- **Message delete detection**: Deleting a queued Slack message (📥) automatically removes it from the processing queue. If a message is already being processed (⏳), deletion has no effect — use `!kill` to interrupt in-flight processing.

## [0.10.0] - 2026-02-23

### Changed
- **Improved Markdown-to-mrkdwn conversion**: `markdownToSlackMrkdwn()` is now code-block-aware — conversions only run on non-code segments so fenced code content is never mangled
- **Bullet point support**: `- item` and `* item` lines are converted to `• item` (Slack has no native bullet syntax)
- **HTML entity escaping**: bare `<` and `&` in plain text are escaped to `&lt;` / `&amp;` before Slack processes the message, preventing accidental mrkdwn token interpretation; Markdown link tokens (`<url|text>`) are created after escaping and remain correct

## [0.9.0] - 2026-02-23

### Changed
- **`stream-native` mode uses typed SDK `chatStream()`**: Replaced raw `apiCall('chat.startStream/appendStream/stopStream')` with the `@slack/web-api` `ChatStreamer` SDK class. Responses are now sent as `markdown_text` so Slack renders native Markdown — no mrkdwn conversion needed.
- **Thinking preview for `stream-native`**: A `:thinking_face: thinking...` placeholder message is posted immediately before Claude starts processing. It's deleted as soon as the first text delta arrives, replaced by the live stream.
- **Faster `stream-update` flush interval**: Reduced from 1000ms to 500ms for snappier real-time updates.

## [0.8.0] - 2026-02-23

### Added
- **`!nudge` command**: Send SIGINT to a running Claude process to interrupt a long tool call and prompt it to wrap up. Works on both persistent and oneshot processes.
  - `!nudge` — nudge the process in the current channel
  - `!nudge #channel` — nudge a process in another channel by name
- **Richer `!ps` output**: Each process line now shows message count, token count (falling back to cost if tokens are unavailable), and an active `:hourglass_flowing_sand:` / `(idle)` indicator
  - Token/cost omitted for fresh or in-flight oneshot processes (not available until exit)
  - Persistent processes accumulate stats turn-by-turn

## [0.7.0] - 2026-02-23

### Added
- **Unit test suite**: 67 tests across 4 files using Jest + ts-jest
  - `ndjson.test.ts` — NDJSON stream-json line parsing (text deltas, result events, user receipts, edge cases)
  - `slack.test.ts` — Markdown-to-mrkdwn conversion, message splitting, duration formatting
  - `config.test.ts` — Config resolution and channel lookups including `processMode`
  - `claude.test.ts` — Session ID derivation (with regression guard), session artifact path encoding
- **Queued reaction**: Bot now reacts with `:inbox_tray:` immediately on message receipt, before any processing begins — provides instant acknowledgement even when a channel is busy
- Tests run automatically on every commit via pre-commit hook (Husky)

### Changed
- Reaction transitions always add the new emoji before removing the old one to prevent visual jumps in Slack
- Refactored internal NDJSON line parsing into a module-level `parseStreamLine()` function shared by both streaming and persistent process paths

## [0.6.0] - 2026-02-23

### Added
- **Persistent process mode**: `processMode: 'persistent'` config option keeps a long-lived Claude CLI
  process per channel. Messages piped via stdin instead of spawning a new process each time —
  eliminates ~2-3s startup overhead and reduces repeated context-loading token costs.
- `processMode` configurable in `defaults` and per channel. Default is `'oneshot'` (fully backwards compatible).
- Persistent processes idle-kill after `timeoutMs` ms of inactivity and auto-respawn on next message.
- All three `responseMode` options (`batch`, `stream-update`, `stream-native`) work with `processMode: persistent`.
- `!ps` and `!kill`/`!killall` commands now include persistent processes in their output/control.

## [0.5.0] - 2026-02-23

### Added
- **Process management commands**: Control running Claude CLI processes directly from Slack
  - `!ps` — list all active processes with channel name, runtime, prompt snippet, and queue stats
  - `!kill` — kill the process running in the current channel
  - `!kill #channel` — kill a process in another channel by name
  - `!killall` — kill all running processes
- **Process registry**: Internal tracking of all running Claude CLI processes, enabling external visibility and control
- Magic commands bypass the message queue and concurrency limits — they execute immediately

## [0.4.1] - 2026-02-23

### Added
- **Global concurrency limit**: Max 8 Claude CLI processes running simultaneously across all channels. Additional messages queue and wait for a slot.

## [0.4.0] - 2026-02-23

### Added
- **Idle-based timeout**: Process timeout now resets on any stdout/stderr activity, so long-running tasks that are actively working won't be killed
- **Absolute timeout safety net**: Hard 12-hour maximum runtime regardless of activity
- **Atomic config save**: `saveConfig()` now writes to a temp file, validates JSON, then atomically renames to prevent corrupt config

### Changed
- Default `timeoutMs` now represents idle timeout (inactivity) rather than absolute elapsed time

## [0.3.0] - 2025-02-23

### Added
- **Image attachment support**: Attach PNG, JPEG, GIF, or WebP images in Slack and Claude will analyze them
  - Images downloaded from Slack using bot token auth, saved to temp directory
  - Image-only messages auto-prompt "What is in this image?"
  - Text + image messages pass both to Claude
  - Temp files automatically cleaned up after processing
  - 5MB per-image size limit
- Requires `files:read` Slack bot token scope

## [0.2.0] - 2025-02-22

### Added
- **Streaming responses**: Real-time message updates in Slack as Claude generates text, instead of waiting for the full response
  - `stream-update` mode: posts a message immediately, updates it every ~2 seconds via `chat.update`
  - `stream-native` mode: uses Slack's native streaming API (`chat.startStream`/`appendStream`/`stopStream`) — experimental
- New `responseMode` config option in `defaults` and per-channel (`batch`, `stream-update`, `stream-native`)
- Long streaming responses automatically fall back to file upload when exceeding 12KB
- Multi-chunk message splitting for streaming responses that exceed Slack's single-message limit

### Changed
- Refactored Claude CLI process spawning to share common logic between batch and streaming modes

## [0.1.0] - 2025-02-15

Initial release.

### Features
- Slack-to-Claude Code CLI gateway via Socket Mode
- Per-channel project folder mapping with deterministic session IDs
- Session persistence across restarts (automatic resume)
- MCP server support (`mcp.json`)
- Self-configuration via natural language in a dedicated Slack channel
- Persistent file-based message queue (survives restarts)
- macOS LaunchAgent support with install/uninstall scripts
- Markdown-to-Slack mrkdwn conversion
- System channel notifications (startup/shutdown)
- Pidfile lock for single-instance enforcement
- Orphan process cleanup on startup
