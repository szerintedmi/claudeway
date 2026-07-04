# Troubleshooting

**Messages queuing unexpectedly:** Global limit of 8 concurrent Claude CLI processes; each channel also serializes its own messages. New messages wait until a slot frees up.

**Process killed too early:** `timeoutMs` is an *idle* timeout — it only fires after that long with no stdout/stderr activity. There's also a hard 12-hour absolute safety net. Increase `timeoutMs` per channel for long tasks.

**Turn refused with a `!creds` hint:** The user hasn't enrolled a Claude token yet — enrollment is mandatory for everyone, bot owner included. DM the bot `!creds`.

**Server won't start (missing secrets key / baseUrl):** `CLAUDEWAY_SECRETS_KEY` (or `.secrets/key`) and `baseUrl` in `config.yaml` are hard startup requirements — the credential store and enrollment form are always on.

**"Session ID already in use":** A previous session didn't exit cleanly. Claudeway clears stale session artifacts and retries once automatically.

**Service won't start via launchd:** Ensure `HOME` and `USER` are set in the plist's `EnvironmentVariables` — Claude Code needs them to find its config.

**"Cannot be launched inside another Claude Code session":** Don't start Claudeway from within a Claude Code terminal — the inherited `CLAUDECODE` env var blocks nested sessions. Use a regular terminal or the LaunchAgent.

**Only one instance runs at a time:** Claudeway uses a pidfile lock (`claudeway.pid`). Stale pidfiles after a crash are detected and cleaned up automatically.

**Images not being analyzed:** The Slack app needs the `files:read` scope. Supported: PNG, JPEG, GIF, WebP (max 5MB each). Non-image files are silently ignored.

**Old temp/scratch dirs after upgrading to per-session temp dirs:** The temp-dir consolidation stopped writing the old stores, but pre-existing dirs linger (they don't conflict with the new `<tempDir>/<channelId>/<sessionId>/` layout, so this is non-urgent). Delete them by hand once — paths are relative to the server working dir (`/app` in Docker):

- `.docker/files/` — entire tree (old per-channel Slack downloads)
- `.claudeway-tmp/req-*` — old per-request outbox dirs
- `.claudeway-tmp/*.current` — old persistent-mode pointer files
- `.claudeway-tmp/scratch/` — old per-channel scratch
