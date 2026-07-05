# Docker reference

How the containerized Claudeway runs. For step-by-step setup see
[deployment.md](deployment.md#docker); this doc is the "what's actually in the
box and why" overview.

## At a glance

- **Base image:** `oven/bun:1-slim` (Debian). Adds `git`, `curl`, Node.js, the
  Claude CLI (`@anthropic-ai/claude-code`), and `uv`/`uvx` (for MCP servers like
  `mcp-atlassian`).
- **Runs as:** non-root user `claudeway`, `WORKDIR /app`, `no-new-privileges`.
- **Entry:** `CMD ["bun", "src/index.ts"]` (no entrypoint script — repo sync
  runs in-app).
- **One container**, defined in [`docker-compose.yml`](../docker-compose.yml).

## What's exposed to the container

| Mechanism | Item | Notes |
|---|---|---|
| **Baked into image** (`COPY`, read-only) | `src/`, `tsconfig.json`, `CLAUDE.md`, `docs/`, `config.example.yaml`, `scripts/claudeway-attach` | Build-time snapshot — rebuild to change |
| | `.claude/` + skills (`--from=skills`) | Skills come from `./.docker/skills-empty` unless you run `scripts/docker-build.sh` |
| **Bind mount (ro)** | `./config.yaml` → `/app/config.yaml` | `create_host_path: false` — container fails fast if missing |
| | `./mcp.json` → `/app/mcp.json` | same |
| **Bind mount (rw)** | `./.docker` → `/app/.docker` | Cloned repos + message queue, persisted to host |
| | `./.docker/claudeway-tmp` → `/app/.claudeway-tmp` | Per-session temp: downloads, generated files, tool scratch, attachment manifests |
| | `./.secrets` → `/app/.secrets` | Encrypted per-user credential store + generated git-credential files |
| **Named volume** | `claudeway-claude-state` → `/home/claudeway/.claude` | Claude CLI session transcripts |
| **tmpfs** | `/tmp` (100 MB) | Ephemeral |
| **Env vars** (from host `.env`, explicitly listed in compose) | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `CLAUDEWAY_SECRETS_KEY` | Claudeway process only — **never** forwarded to the Claude subprocess |
| | `DEEPGRAM_API_KEY`, `VOICE_AUTH_TOKEN` | Voice pipeline |
| | `SHARED_JIRA_*`, `SHARED_GITHUB_TOKEN`, `SHARED_NEWRELIC_API_KEY`, `SHARED_LANGFUSE_*` | Shared credential defaults; reach the subprocess **only** via `userCredentials` mappings |
| **Ports** | `${VOICE_PORT:-8765}`, `${CREDS_PORT:-8791}` | Voice WebSocket + `!creds` enrollment form |

**`.env` is not mounted.** It's in `.dockerignore`; only the vars named in the
compose `environment:` block are interpolated in. Anything else in `.env` never
reaches the container. `config.yaml` and `mcp.json` are also excluded from the
image and re-supplied as read-only mounts.

## Two-layer env model

Secrets pass through two independent gates, which is why a value in `.env`
doesn't automatically reach the agent:

1. **Host → container** — `docker-compose.yml`'s `environment:` list. Only the
   ~14 named vars enter the container.
2. **Container → Claude subprocess** — the allowlist in
   [`buildAllowedEnv`](../src/claude-spawn-env.ts). The subprocess receives only:
   baseline vars (`HOME`, `PATH`, …) + `config.env` + permission-linked
   `permissions.<name>.env` + injected vars (git identity, temp dirs) + resolved
   `userCredentials`.

So `SLACK_BOT_TOKEN` and `CLAUDEWAY_SECRETS_KEY` enter the container (gate 1) but
are deliberately withheld from the agent (gate 2). Provider tokens
(`SHARED_*`) reach the agent only through a matching `userCredentials` entry.

## Git authentication

Token-based over HTTPS — no SSH key mount:

- `SHARED_GITHUB_TOKEN` + a `userCredentials.github` mapping
  (`exposeAs: git-credential-helper`, `defaultFromEnv: SHARED_GITHUB_TOKEN`)
  authenticate both startup repo sync and the agent's git operations.
- A generated per-spawn gitconfig rewrites SSH remotes (`git@github.com:…`) to
  HTTPS and points a `github.com`-scoped credential helper at the token
  ([git-credentials.ts](../src/git-credentials.ts)). The token never enters the
  subprocess env.
- A user who enrolls a personal GitHub PAT via `!creds` uses it for their own
  turns; otherwise the shared token applies. Precedence: **personal > shared
  default > unset**.

## Persistence

Survives `docker compose up`/`down`/recreate via the mounts above:

| State | Location |
|---|---|
| Cloned repos + message queue | `./.docker` |
| Per-session working files | `./.docker/claudeway-tmp` |
| Encrypted credential store | `./.secrets` |
| Claude session transcripts | `claudeway-claude-state` volume |

`$TMPDIR` points at `<session>/tmp` under the bind-mounted temp base, so generic
tool scratch (`mktemp`, Python `tempfile`, …) lands on disk under the mount
rather than the 100 MB `/tmp` tmpfs.

## Startup sequence

`bun src/index.ts` →

1. Load config (hot-reloaded per message thereafter).
2. Wipe stale generated git-credential files, then `syncRepos()` — clone/pull
   every repo in `config.yaml` over HTTPS with the shared PAT.
3. Start the Slack adapter, the voice WebSocket server (if enabled), and the
   `!creds` enrollment form (always on).

## Build & run

```bash
docker compose up -d --build          # build + start
docker compose logs -f                # follow logs
docker compose up -d --build          # apply Dockerfile/compose changes
```

To bake Claude CLI skills into the image:

```bash
cp docker-skills.conf.example docker-skills.conf   # list global skill paths
bash scripts/docker-build.sh
```
