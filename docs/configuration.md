# Configuration Reference

`config.yaml` lives in the project root and is **hot-reloaded per message** — edits take effect on the next message, no restart needed. See [`config.example.yaml`](../config.example.yaml) for a complete annotated example.

## Top-level

| Field | Description | Default |
|-------|-------------|---------|
| `botOwners` | Owner list — `users:` registry keys (preferred) or raw Slack ids. Owners get startup/shutdown DMs and all magic commands | none (global commands disabled) |
| `baseUrl` | **Required.** Public base URL of the `!creds` enrollment form | — |
| `credsForm.port` | Enrollment form port | `8791` |
| `credsForm.host` | Interface the enrollment form binds to. Set to `127.0.0.1` or a LAN/VPN address to narrow exposure when the host also faces untrusted networks | `0.0.0.0` |
| `users` | Canonical person registry: `id: { name, slack, voice, permissions }`. The key is the canonical user id — stable across Slack/voice identities; keys the secret store, audit log, and persistent-process identity | none |
| `repos` | Repo definitions (`url`, optional `branch`) — cloned/pulled into `.docker/repos/` on every startup | none |
| `channels` | Channel-to-repo mappings (below) | required |
| `defaults` | Channel defaults (below) | required |
| `env` | Non-credential env var **names** passed to Claude subprocesses. Subprocess env is allowlisted — nothing else from the server env leaks through | baseline vars only |
| `permissions` | Named permission → `{ env: [...] }`. Users granted a permission (via registry or channel `members`) get those env vars in their spawns | none |
| `userCredentials` | Credential definitions for shared defaults and `!creds` enrollment (below) | built-in `claude` credential only |
| `voiceServer` | WebSocket voice server (`enabled`, `port`, `auth.tokens`) | disabled |
| `voice` | STT/TTS pipeline (`provider: deepgram`, API key, models) | none |

## Channel

| Field | Description | Default |
|-------|-------------|---------|
| `name` | Display name for logs and `!kill #name` targeting | required |
| `repo` | Repo name from the `repos` map | required |
| `members` | Users (registry keys) allowed to interact in this channel; allowed users can use configured shared credential defaults | everyone in the channel |
| `model` | Claude model (`opus`, `sonnet`, or any `--model` value) | from defaults |
| `effort` | Thinking effort: `low`\|`medium`\|`high`\|`xhigh`\|`max` (validated at load) | from defaults |
| `systemPrompt` | Custom system prompt | from defaults |
| `timeoutMs` | Idle timeout in ms (resets on activity) | from defaults |
| `processMode` / `responseMode` / `triggerMode` | See below | from defaults |
| `threadWorktrees` | Run each thread in its own git worktree (repo-backed channels). Submodule paths inside thread worktrees are read-only symlinks to the main synced checkout. | `true` |
| `collapseWorkingNotes` | `stream-native` only: live work log of step cards (narration titles, tool/subagent activity as details lines), collapsed on completion; `false` drops reasoning and streams narration into the answer body | `true` |

Defaults-only fields: `tempDir` (`.claudeway-tmp`), `tempMaxAgeDays` (`90`, `0` disables), `threadWorktreeMaxAgeDays` (`14`, `0` disables).

`tempDir` is the base for one working directory **per Claude session** (`<tempDir>/<channelId>/<sessionId>/`), holding inbound downloads (`incoming/`), files Claude generates, generic tool temp (`tmp/`, also exposed as `$TMPDIR`), and the outbound attachment manifest. Everything persists across turns within a session; `tempMaxAgeDays` reclaims a whole session dir once it has been idle that long.

## Trigger Modes

| Mode | Description |
|------|-------------|
| `all` | Respond to every message. Default — for dedicated bot channels. |
| `mention` | Only respond when `@mentioned` — for shared channels. The mention is stripped from the prompt; when invoked in a thread, the thread history is prepended as context. |

## Process Modes

| Mode | Description |
|------|-------------|
| `oneshot` | Fresh `claude -p` per message. Default, fully isolated, ~2-3s startup. |
| `persistent` | One long-lived process per channel, messages piped via stdin. No startup overhead. Idle-kills after `timeoutMs`, auto-respawns. Respawned with `--resume` (context preserved) when the incoming user's identity, permissions, env exposure, or credential hash differs from the running process. |

`processMode` and `responseMode` are independent — any combination works.

## Response Modes

| Mode | Description |
|------|-------------|
| `batch` | Wait for the full response, then post. Default, most reliable. |
| `stream-update` | Post immediately, update every ~500ms via `chat.update`. Recommended streaming mode. |
| `stream-native` | Slack's native streaming API with real Markdown rendering. Shows a live "Work log" of step cards (one per narrated step, tool activity as its rolling details line) that collapses when done (`collapseWorkingNotes: false` disables); the optional `---DETAILS---` section streams live and folds into a collapsed "Details" box once the turn completes. **Requires Enterprise Grid** — won't work on standard workspaces. |

If a streamed response exceeds 12KB, it falls back to a file upload.

## Credentials

Per-user credential setup and operations are covered in [per-user-credentials.md](per-user-credentials.md). Config shape:

| Field | Description |
|-------|-------------|
| `userCredentials.<name>.label` | Display label on the enrollment form |
| `userCredentials.<name>.guidance` | Help text on the enrollment form |
| `userCredentials.<name>.fields.<FIELD>` | Field stored per user and exposed to the subprocess/tool; `label`, `secret` (mask on form, default true), `defaultFromEnv` (explicit shared default env var) |
| `userCredentials.<name>.exposeAs` | `env` (default) or `git-credential-helper` — the token never enters the subprocess env; delivered to `git` via a per-spawn credential helper |
| `userCredentials.<name>.sharedAccessNote` | What the shared default can't do — injected into the system prompt so the agent warns preemptively instead of failing mid-task |
| `userCredentials.<name>.mcpReadOnlyServers` | MCP servers forced read-only (`READ_ONLY_MODE=true`) when this credential doesn't resolve to a personal secret |

Resolution precedence: **user secret > explicit shared default > unset**. There is no ambient fallback from matching server env var names. The `claude` credential is built-in, always on, and not configurable.
