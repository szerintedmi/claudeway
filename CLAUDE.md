# CLAUDE.md

## Primary Design Principle

Always adhere to Anthropic's Terms of Service 100%. Claudeway is a personal tool operated by a single developer through the official Claude Code CLI. Trusted collaborators may use it with **their own credentials**: each user can authenticate with their own Claude subscription/token (`!creds` enrollment), and downstream actions (git, Jira) run under and are attributed to their own accounts. Claudeway never extracts OAuth tokens and never routes requests through third-party backends.

## Project Overview

Claudeway is a multi-channel Claude Code CLI gateway. Messages arrive via Slack Socket Mode or a WebSocket voice interface (with configurable STT/TTS providers), get processed by the Claude CLI (`claude -p`), and responses are delivered back through the originating channel.

User-facing docs: `README.md` (quick start, commands) + `docs/configuration.md`, `docs/deployment.md`, `docs/troubleshooting.md`, `docs/per-user-credentials.md` — keep them in sync with behavior changes.

## Architecture

### Server (TypeScript / Bun)

- `src/index.ts` — Entry point, adapter startup, pidfile lock, lifecycle management
- `src/core/engine.ts` — Channel-agnostic message processing, concurrency pool
- `src/core/interfaces.ts` — `ChannelAdapter`, `ChannelResponder`, `IStreamingResponder`
- `src/core/voice.ts` — Provider-agnostic STT/TTS interface (supports server-side, client-side, and local modes)
- `src/core/voice-deepgram.ts` — Deepgram Nova-3 (STT) + Aura-2 (TTS) implementation
- `src/core/prose-chunker.ts` — Sentence-boundary text chunking for TTS
- `src/adapters/slack/` — Slack Bolt adapter (handler, responder, formatting, thread context)
- `src/adapters/voice/` — WebSocket voice adapter (protocol, handler, responder, audio sessions, test UI) — used by Android companion app, Meta glasses, and browser test UI
- `src/adapters/creds/` — Credential enrollment web form (magic-link gated, rate-limited)
- `src/claude.ts` — Claude CLI orchestration (batch and streaming process runners)
- `src/config.ts` — Config loading/saving, channel resolution with defaults, `users:` registry + permission resolution
- `src/queue.ts` — Persistent file-based message queue
- `src/mcp.ts` — MCP config management (read-only config generation for permission enforcement)
- `src/prompt.ts` — System prompt construction including credential-status injection
- `src/tempdir.ts` — Temp and scratch directory management
- `src/sync-repos.ts` — Git clone/pull for configured repos on startup
- `src/secrets.ts` — Encrypted per-user credential store (AES-256-GCM behind a `SecretStore` interface) + secret scrubbing
- `src/credentials.ts` — Config-driven per-user credential resolution (personal > explicit shared default > unset)
- `src/git-credentials.ts` — Git enforcement adapter: per-spawn gitconfig + credential helper (tokens out of subprocess env)
- `src/creds-links.ts` — Single-use, short-TTL magic links for `!creds` enrollment
- `src/creds-hint.ts` — Canonical "send `!creds` in a *direct message* to `<@bot>`" copy + bot identity (shared by engine refusals, onboarding, `!whoami`, prompt block)
- `src/audit.ts` — Append-only JSONL audit log (credential names, never values)
- `src/worktrees.ts` — Per-thread git worktrees (thread isolation) + age-based GC

### Android Companion App (Kotlin / Jetpack Compose)

- `android/app/src/main/kotlin/com/claudeway/`
  - `network/` — WebSocket client (OkHttp), protocol types matching server
  - `audio/` — Bluetooth SCO routing, PCM capture (8kHz mono), playback (supports server TTS, client-side Deepgram TTS, and Android built-in TTS)
  - `voice/` — VoiceViewModel state machine, UI state types (VoiceFlowState, ConversationMessage)
  - `glasses/` — Meta DAT SDK integration (GlassesManager, GlassesState)
  - `ui/` — Jetpack Compose screens (connection, conversation, settings for STT/TTS mode selection)

## Key Patterns

- Repos are cloned/pulled on every startup (`syncRepos()` in `src/sync-repos.ts`), shared by both `bun start` and Docker
- Config (`config.yaml`) is hot-reloaded per message — `loadConfig()` is called fresh in both `processQueuedMessage` and `registerMessageHandler`
- Session IDs are deterministic (derived from channel ID + folder path via UUID v5)
- One message processed at a time per channel (serialized via `channelBusy` set)
- Bot does NOT programmatically join Slack channels — requires manual `/invite` + config entry
- Magic commands (`src/adapters/slack/commands.ts`) have scoped authorization: `!help`/`!whoami` are open to anyone anywhere; `!ps`/`!kill`/`!nudge` require channel membership; `!config`/`!killall`/cross-channel targeting require `botOwners`; `!creds` (+ `list`/`revoke`) is DM-only
- Subprocess env vars are allowlisted in `buildAllowedEnv()` in `src/claude.ts`. Only baseline vars (`HOME`, `PATH`, etc.) + non-credential `env` + permission-linked env vars + explicitly injected vars + resolved user credentials reach the subprocess.
- Repo-backed channels run each Slack thread in its own git worktree (`wt/<channel>/<threadTs>`, `src/worktrees.ts`) — thread participants share files, concurrent threads are isolated, session IDs keep deriving from the logical repo folder. New worktrees are based on `origin/<branch>` after a throttled fetch (fallback: local HEAD); unpopulated submodules are replaced with read-only symlinks to the main synced checkout on create/reuse (`git worktree add` doesn't recurse; populated ones are never touched); startup GC keeps worktrees with uncommitted or unmerged work regardless of age.

## Users & Per-User Credentials

Channel access is the normal permission boundary: users listed in a channel can use the bot there, including configured shared credential defaults.

- People are defined once in the top-level `users:` registry (canonical id → name, Slack id, voice id); channels reference them via `members:`. The removed legacy `allowedUsers` shape is rejected at config load with a migration hint.
- The canonical user id keys the secret store, audit log, and persistent-process identity — stable across a person's Slack and voice identities.
- `userCredentials` defines credential fields, form labels/guidance, explicit shared defaults via `defaultFromEnv`, and delivery via `exposeAs` (`env` or `git-credential-helper`).
- Resolution precedence is **user secret > explicit shared default > unset**. There is no ambient fallback from matching env var names.
- Credentials resolved from a shared default or left unset are surfaced to the agent via a "Credential status" system-prompt block (`buildCredentialStatus` in `src/prompt.ts`); `userCredentials.<name>.sharedAccessNote` declares what the shared token can't do, so the agent refuses doomed writes and points at `!creds` preemptively instead of failing mid-task.
- Provider token scope controls read/write capability where tokens can be scoped (GitHub). Atlassian API tokens can't be scoped, so `userCredentials.<name>.mcpReadOnlyServers` lists MCP servers forced read-only (`READ_ONLY_MODE=true` in a generated config, `src/mcp.ts`) whenever that credential does not resolve to a personal secret. Tool-layer guardrail against accidental writes attributed to the shared token's owner — not a security boundary; the shared token still reaches the subprocess env.
- **BYO Claude is built-in and always on**: the `claude` credential is injected by `loadConfig()` (not configurable) and personal enrollment is mandatory for **everyone**, bot owner included — unenrolled users' turns are refused with a `!creds` hint (audited as `spawn.denied`). Hard startup requirements: a secrets master key (`CLAUDEWAY_SECRETS_KEY` or `.secrets/key`) and `baseUrl` (the enrollment form always runs). Store: AES-256-GCM in `.secrets/user-credentials.json`.

Credential layers:
1. **Git credential adapter** — `exposeAs: git-credential-helper` uses a per-spawn gitconfig (SSH→HTTPS rewrite + credential helper); the token does not enter subprocess env.
2. **Env credential delivery** — `exposeAs: env` injects resolved fields into the subprocess env at highest precedence.
3. **Git author identity** — commits are attributed to the registry name / Slack profile.
4. **Audit + scrubbing** — every credentialed spawn and enrollment event lands in `.claudeway-audit.jsonl` (names, never values); decrypted values are scrubbed from stderr logs and error replies.

In persistent mode, the process is killed and respawned with `--resume` when the incoming user's identity, permission set, resolved env var exposure, or credential-value hash differs from the running process.

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
