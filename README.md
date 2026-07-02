# Claudeway

Multi-channel Claude Code CLI gateway — Slack, voice, and Android.

Messages arrive via Slack (Socket Mode) or a WebSocket voice interface, get processed by the Claude CLI (`claude -p`) on your machine, and responses return through the originating channel. It's a remote terminal with Slack and voice as transport layers — no third-party backends, no token extraction.

```
You (Slack)   --> Socket Mode --> Claudeway (your machine) --> claude CLI --> Slack thread
You (Voice)   --> WebSocket   --> Claudeway (your machine) --> claude CLI --> TTS audio
```

Auth is **per-user**: everyone (bot owner included) enrolls their own Claude token via a `!creds` DM, and downstream actions (git, Jira) run under their own accounts. See [docs/per-user-credentials.md](docs/per-user-credentials.md).

## How It Works

1. You send a message (optionally with images) in a configured Slack channel
2. Claudeway spawns `claude -p` (or pipes into a long-lived process, per `processMode`) in the channel's repo
3. The response is posted back as a threaded reply
4. Reactions show status: 📥 queued, ⏳ processing, ✅ done, ❌ error. Deleting a queued (📥) message removes it from the queue; if already processing (⏳), use `!kill`.

Each channel maps to a repo. Session IDs derive deterministically from the channel + repo pair, so conversations survive restarts. Repo-backed channels run each Slack thread in its own git worktree, so concurrent threads don't collide.

## Setup

### 1. Create a Slack app

Create the app from the included manifest — it defines all required scopes, events, and Socket Mode settings:

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste [`slack-app-manifest.example.yaml`](slack-app-manifest.example.yaml)
2. Generate an **App-Level Token** with the `connections:write` scope (manifests can't create these)
3. Install the app to your workspace, copy the Bot Token (`xoxb-...`), and `/invite @YourBot` to your channels

### 2. Install and configure

```bash
git clone https://github.com/ktamas77/claudeway.git
cd claudeway
bun install
```

Create `.env` (full list in [`.env.example`](.env.example)):

| Variable | Required | Purpose |
|----------|----------|---------|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-...`) |
| `CLAUDEWAY_SECRETS_KEY` | yes* | Master key for the encrypted per-user credential store (`openssl rand -hex 32`) |
| `VOICE_AUTH_TOKEN` | voice only | WebSocket voice client auth token |
| `DEEPGRAM_API_KEY` | voice only | STT/TTS provider key |
| `SHARED_*` | optional | Shared credential defaults referenced by `userCredentials.*.defaultFromEnv` |
| `GIT_SSH_KEY` | Docker only | SSH key path for repo cloning |

\* Alternatively put the key in `.secrets/key`. The server refuses to start without it.

Create `config.yaml` — minimal example (full reference: [docs/configuration.md](docs/configuration.md), complete annotated example: [`config.example.yaml`](config.example.yaml)):

```yaml
botOwners: [alice]

baseUrl: "http://192.168.1.10:8791"  # required — how users reach the !creds enrollment form

users:
  alice: { name: "Alice Doe", slack: U0123456789 }

repos:
  my-project:
    url: https://github.com/org/my-project.git

channels:
  C0123456789:
    name: my-project
    repo: my-project
    members: [alice]

defaults:
  model: opus
  timeoutMs: 1800000
  processMode: oneshot
  responseMode: batch
```

Optionally add `mcp.json` to give Claude access to MCP servers (see [`mcp.example.json`](mcp.example.json)).

### 3. Run

```bash
bun start    # or: bun dev (auto-reload)
```

Recommended for local use — keep the Mac awake and expose the voice/creds endpoints through a Cloudflare tunnel:

```bash
caffeinate -i bash -c 'bun run start & cloudflared tunnel run claudeway & wait'
```

Then each user DMs the bot `!creds` and pastes the output of `claude setup-token` into the enrollment form.

Tunnel setup (including the ingress config for the creds form): [docs/deployment.md](docs/deployment.md) and [docs/cloudflare.md](docs/cloudflare.md). For macOS background service or Docker, see [docs/deployment.md](docs/deployment.md).

## Slack Commands

Magic commands bypass the message queue and execute immediately.

| Command | Description | Who |
|---------|-------------|-----|
| `!help` | List commands and channel info | anyone, anywhere |
| `!whoami` | Show your identity, channels, permissions, enrolled credentials | anyone, anywhere |
| `!ps` | Active processes + queue depth (non-owners see their channel only) | channel members |
| `!kill` | Kill the process in the current channel | channel members |
| `!nudge` | SIGINT the current process — interrupts a tool call, prompts wrap-up | channel members |
| `!kill #chan` / `!nudge #chan` | Same, targeting another channel | bot owners |
| `!killall` | Kill all running processes | bot owners |
| `!config` | Show channel/bot configuration | bot owners |
| `!creds` | Get a credential enrollment link (DM only) | any allowed user |
| `!creds list` / `!creds revoke <name>\|all` | Manage your own credentials (DM only) | any allowed user |
| `!creds list @user` / `!creds revoke @user [name\|all]` | Inspect/offboard another user | bot owners |

**Per-message overrides** ride the normal queue — prefix a message with either or both:

- `!model:<name>` — run one message on a different model (passed straight to `claude --model`)
- `!effort:<level>` — thinking effort for one message (`low`|`medium`|`high`|`xhigh`|`max`; validated, invalid levels rejected in-thread)

Overrides compose with magic commands and are re-parsed if you edit a still-queued message. Persistent sessions respawn with `--resume`, preserving context.

## Voice Channel

WebSocket-based voice interface with configurable STT/TTS (Deepgram Nova-3 / Aura-2). Three clients:

- **Android companion app** — push-to-talk / hands-free, Bluetooth, barge-in, Meta glasses integration. See [android/README.md](android/README.md).
- **Web test UI** — served at the voice adapter's HTTP endpoint.
- **Any WebSocket client** — implement the protocol in `src/adapters/voice/`.

TTS runs server-side (Deepgram), client-side, or local (Android built-in TTS). To expose the WebSocket beyond your LAN, see [docs/cloudflare.md](docs/cloudflare.md).

## Documentation

- [docs/configuration.md](docs/configuration.md) — full config reference (channels, modes, credentials, env)
- [docs/per-user-credentials.md](docs/per-user-credentials.md) — per-user credential setup & operations
- [docs/deployment.md](docs/deployment.md) — macOS LaunchAgent and Docker
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues

## Development

```bash
make help          # all targets (server + android)
make server-dev    # run with auto-reload
make test          # run all tests
make lint          # lint everything
```

Direct `bun` scripts also work (`bun dev`, `bun test`, …) — see `package.json`. Unit tests cover the pure-function layer and run on every commit via the pre-commit hook.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- A Claude Pro/Max subscription per user (each user enrolls their own token)
- [Bun](https://bun.sh) 1.0+

## License

MIT — see [CHANGELOG.md](CHANGELOG.md) for release history.
