# CLAUDE.md

## Primary Design Principle

Always adhere to Anthropic's Terms of Service 100%. Claudeway is a personal tool for a single developer using their own Claude Max subscription through the official Claude Code CLI. It does not extract OAuth tokens, route requests through third-party backends, or operate as a multi-user service.

## Project Overview

Claudeway is a Slack-to-Claude Code CLI gateway. Messages arrive via Slack Socket Mode, get processed by the Claude CLI (`claude -p`), and responses are posted back as threaded replies.

## Architecture

- `src/index.ts` — Entry point, Slack Bolt app setup, pidfile lock, lifecycle management
- `src/slack.ts` — Message handling, response delivery (batch/streaming), Slack formatting
- `src/claude.ts` — Claude CLI orchestration (batch and streaming process runners)
- `src/config.ts` — Config loading/saving, channel resolution with defaults
- `src/queue.ts` — Persistent file-based message queue

## Key Patterns

- Config (`config.json`) is hot-reloaded per message — `loadConfig()` is called fresh in both `processQueuedMessage` and `registerMessageHandler`
- Session IDs are deterministic (derived from channel ID + folder path via UUID v5)
- One message processed at a time per channel (serialized via `channelBusy` set)
- Bot does NOT programmatically join Slack channels — requires manual `/invite` + config entry
- Magic commands (`!kill`, `!killall`, `!nudge`, `!config`, `!ps`) have authorization checks via `isMagicCommandAllowed()` — `botOwner` for global commands, channel `allowedUsers` for channel-scoped commands

## Branch Strategy (Fork)

- `main` — synced with `upstream` (`ktamas77/claudeway`), used as base for upstream PRs
- `my-main` — personal running branch with private features, rebased on `main`
- `feature/*` — for upstream PRs, branch off `main`; for private features, merge into `my-main` only

Remotes: `origin` = `szerintedmi/claudeway` (fork), `upstream` = `ktamas77/claudeway` (original)

## Development

```bash
bun start        # Run with bun
bun dev          # Run with bun --watch (auto-reload)
bun run build    # TypeScript compile
bun run typecheck # Type check only
bun run lint     # ESLint
bun run format   # Prettier
bun test         # Run tests
```
