# Changelog

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
