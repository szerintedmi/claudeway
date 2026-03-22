# CLAUDE.md

## Primary Design Principle

Always adhere to Anthropic's Terms of Service 100%. Claudeway is a personal tool for a single developer using their own Claude Max subscription through the official Claude Code CLI. It does not extract OAuth tokens, route requests through third-party backends, or operate as a multi-user service.

## Project Overview

Claudeway is a multi-channel Claude Code CLI gateway. Messages arrive via Slack Socket Mode or a WebSocket voice interface (with configurable STT/TTS providers), get processed by the Claude CLI (`claude -p`), and responses are delivered back through the originating channel.

## Architecture

### Server (TypeScript / Bun)

- `src/index.ts` — Entry point, adapter startup, pidfile lock, lifecycle management
- `src/core/engine.ts` — Channel-agnostic message processing, concurrency pool
- `src/core/interfaces.ts` — `ChannelAdapter`, `ChannelResponder`, `IStreamingResponder`
- `src/core/voice.ts` — Provider-agnostic STT/TTS interface (supports server-side, client-side, and local modes)
- `src/core/voice-deepgram.ts` — Deepgram Nova-3 (STT) + Aura-2 (TTS) implementation
- `src/core/prose-chunker.ts` — Sentence-boundary text chunking for TTS
- `src/adapters/slack/` — Slack Bolt adapter (handler, responder, formatting, thread context)
- `src/adapters/glasses/` — WebSocket voice adapter (protocol, handler, responder, audio sessions, test UI) — used by Android companion app, Meta glasses, and browser test UI
- `src/claude.ts` — Claude CLI orchestration (batch and streaming process runners)
- `src/config.ts` — Config loading/saving, channel resolution with defaults, user permission parsing
- `src/queue.ts` — Persistent file-based message queue
- `src/mcp.ts` — MCP config management (read-only config generation for permission enforcement)
- `src/prompt.ts` — System prompt construction including access restriction injection
- `src/tempdir.ts` — Temp and scratch directory management
- `src/sync-repos.ts` — Git clone/pull for configured repos on startup

### Android Companion App (Kotlin / Jetpack Compose)

- `android/app/src/main/kotlin/com/claudeway/glasses/`
  - `network/` — WebSocket client (OkHttp), protocol types matching server
  - `audio/` — Bluetooth SCO routing, PCM capture (8kHz mono), playback (supports server TTS, client-side Deepgram TTS, and Android built-in TTS)
  - `glasses/` — Meta DAT SDK integration, ViewModel state machine
  - `ui/` — Jetpack Compose screens (connection, conversation, settings for STT/TTS mode selection)

## Key Patterns

- Repos are cloned/pulled on every startup (`syncRepos()` in `src/sync-repos.ts`), shared by both `bun start` and Docker
- Config (`config.yaml`) is hot-reloaded per message — `loadConfig()` is called fresh in both `processQueuedMessage` and `registerMessageHandler`
- Session IDs are deterministic (derived from channel ID + folder path via UUID v5)
- One message processed at a time per channel (serialized via `channelBusy` set)
- Bot does NOT programmatically join Slack channels — requires manual `/invite` + config entry
- Magic commands (`!kill`, `!killall`, `!nudge`, `!config`, `!ps`) have authorization checks via `isMagicCommandAllowed()` — `botOwner` for global commands, channel `allowedUsers` for channel-scoped commands

## User Roles & Permissions

Every user is **read-only by default**. Permissions are additive. The `botOwner` has full access implicitly unless explicitly listed in `allowedUsers` (useful for testing).

- `allowedUsers` supports mixed entries: plain string (read-only) or `"userId": [git, jiraWrite]`
- `git` — enables git push/commit and file modification
- `jiraWrite` — uses full MCP config instead of read-only MCP config

Enforcement layers:
1. **System prompt injection** — read-only restrictions appended per user (soft guard)
2. **Git credential stripping** — env vars disable git auth for non-`git` users (hard)
3. **Git author identity** — commits attributed to Slack user profile (all users)
4. **MCP read-only config** — `mcp-readonly.json` auto-generated with `READ_ONLY_MODE: "true"` (hard)

In persistent mode, the process is killed and respawned with `--resume` when the incoming user's permission set differs from the running process.

## Branch Strategy (Fork)

- `main` — synced with `upstream` (`ktamas77/claudeway`), used as base for upstream PRs
- `my-main` — personal running branch with private features, rebased on `main`
- `feature/*` — for upstream PRs, branch off `main`; for private features, merge into `my-main` only

Remotes: `origin` = `szerintedmi/claudeway` (fork), `upstream` = `ktamas77/claudeway` (original)

## Development

All targets available via `make help`. Key commands:

```bash
# Top-level (both server + android)
make all              # Build everything
make test             # Run all tests
make lint             # Lint everything
make clean            # Clean all build artifacts

# Server (TypeScript / Bun)
make server-build     # TypeScript compile
make server-test      # Run tests
make server-lint      # ESLint
make server-format    # Prettier
make server-typecheck # Type check only
make server-dev       # Run with auto-reload
make server-start     # Run server

# Android
make android-build    # Build debug + release APKs
make android-test     # Unit tests
make android-lint     # Android lint
make android-install  # Build and install on connected device
```

Direct bun/gradle commands still work — see `package.json` scripts and `android/README.md`.

### Android prerequisites

JDK 17+ and Android SDK (compileSdk 36, targetSdk 35, minSdk 29). See `android/README.md` for setup.

## Docker Skills

Claude CLI skills (e.g., qmd, markitdown) live in `~/.claude/` as the global source of truth. To include them in the Docker image:

1. `cp docker-skills.conf.example docker-skills.conf`
2. Add paths to your global skills (one per line)
3. `bash scripts/docker-build.sh` (syncs skills into Docker image via `--build-context`)

`docker-skills.conf` is gitignored — each developer maintains their own.
