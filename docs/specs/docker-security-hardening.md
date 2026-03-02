# Docker Containerization + Security Hardening

## Context

Claudeway runs `claude -p` with `--dangerously-skip-permissions`, which means the Claude CLI inherits the full process environment (including `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`) and can read any file on disk (including `.env`). Any Slack user with channel access could ask Claude to output tokens or act with those credentials. Docker containerization + env var stripping addresses both the token exposure risk and provides filesystem isolation.

## Changes

### 1. Strip Slack Tokens from Claude CLI Environment

**File:** `src/claude.ts`

Both `spawnClaudeProcess()` and `createPersistentProcess()` already strip `CLAUDECODE` from the env before spawning the CLI. Two additional deletions prevent Slack tokens from leaking:

```ts
delete env.SLACK_BOT_TOKEN;
delete env.SLACK_APP_TOKEN;
```

This is the most important change — it works with or without Docker.

A warning is logged when the CLI exits with code 0 but produces no response output, with the tail of stderr for diagnostics. This catches silent failures like missing directories or config issues inside the container.

### 2. Dockerfile

**File:** `Dockerfile`

- Base image: `oven/bun:1-slim` (Debian slim, ~65MB)
- Installs `git`, `nodejs`, `npm` (Node.js/npm needed for `@anthropic-ai/claude-code` npm package)
- Installs Claude CLI globally via `npm install -g @anthropic-ai/claude-code`
- Creates non-root `claudeway` user for defense in depth
- Copies dependency files first for Docker layer caching, then source code
- Copies project `.claude/` directory (skills, etc.) into the image — `settings.local.json` excluded via `.dockerignore`
- Configures git credential store pointing to `/home/claudeway/.git-credentials` (mounted at runtime)
- Creates runtime directories (`.queue`, `.files`, `.claudeway-tmp`)
- `.env` is NOT copied into the image — tokens are passed as env vars at runtime only

### 3. Repo Management

**Config:** `config.yaml` gains a top-level `repos` map declaring all repositories:

```yaml
repos:
  copilot-spike:
    url: https://github.com/org/copilot-spike.git
    branch: main
  other-repo:
    url: https://github.com/org/other-repo.git

channels:
  C0123456789:
    name: my-project
    repo: copilot-spike              # primary repo, used as cwd
    additionalRepos: [other-repo]    # optional: extra repos, cloned alongside
```

**Resolution:** `repo` is a key from the `repos` map, resolved to `.repos/<name>` via `resolveFolder()`. The Claude agent's cwd is `.repos/<primary>/`; additional repos are accessible via `../<name>`.

**Validation:** `loadConfig()` validates that each channel's `repo` and `additionalRepos` entries reference keys in the `repos` map.

**Directory structure:**
```
.repos/
├── copilot-spike/           ← cwd for the channel
│   └── .claude/skills/      ← repo-specific skills (highest priority)
└── shared-lib/              ← accessible via ../shared-lib
```

**Entrypoint (Docker):** `docker-entrypoint.sh` runs before the app starts:
- Parses `config.yaml` to extract the `repos` map
- Not cloned yet → `git clone [--branch <branch>] <url> .repos/<name>`
- Already cloned → `git stash`, `git fetch origin`, checkout branch, `git pull --ff-only`; logs warning if stash was non-empty
- Ends with `exec "$@"` to hand off to CMD

**Local usage:** No entrypoint needed — user clones or symlinks repos into `.repos/` manually.

**Skills discovery:** Claude traverses up from cwd (`.repos/<name>/`) to the app root, finding `/app/.claude/skills/` (Claudeway's bundled skills). If the repo has its own `.claude/skills/`, those take priority.

### 4. docker-compose.yml

**File:** `docker-compose.yml`

**Environment:**
- `.env` loaded via `env_file` — Docker sets tokens on the Claudeway process, but code strips them before spawning Claude CLI
- `HOME` and `USER` set explicitly for the container user

**Authentication:**
- Claude CLI authenticates via `CLAUDE_CODE_OAUTH_TOKEN` env var (generated with `claude setup-token` on an authenticated machine)
- No host `~/.claude` or `~/.claude.json` files are mounted — auth is token-only
- Slack tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) are stripped from the env before spawning the CLI, but `CLAUDE_CODE_OAUTH_TOKEN` is passed through

**Volumes:**
- `config.yaml` and `mcp.json` mounted read-only — Claude can read them but can't modify from inside the container
- Claude CLI session state: named volume (`claudeway-claude-state`) at `/home/claudeway/.claude` — created at runtime, seeded with directories from the image on first creation
- Git SSH key: private key mounted read-only at `/home/claudeway/.ssh/id_ed25519`
- Repos: named volume (`claudeway-repos`) at `/app/.repos` — repos are cloned/pulled by the entrypoint on startup
- Named volumes (`claudeway-queue`, `claudeway-files`, `claudeway-claude-state`, `claudeway-repos`) for persistent state across container recreations

**Security:**
- `no-new-privileges:true` — prevents privilege escalation inside the container
- `tmpfs` on `/tmp` with 100M limit

**Git SSH setup:** The container mounts your SSH private key read-only at `/home/claudeway/.ssh/id_ed25519`. The Dockerfile creates an SSH config that uses this key for `github.com` with `StrictHostKeyChecking accept-new`. Use `git@github.com:` SSH URLs in the `repos` config. The key is read-only inside the container — Claude gets `git pull`/`git fetch` but push depends on the key's GitHub permissions.

### 5. .dockerignore

**File:** `.dockerignore`

Excludes secrets (`.env`, `config.yaml`, `mcp.json`), build artifacts (`node_modules/`, `dist/`), repo history (`.git/`), local dev settings (`.claude/settings.local.json`), and runtime state (`.queue/`, `.files/`, logs, pidfiles) from the Docker image.

### 6. .gitignore

**File:** `.gitignore`

Added `.git-credentials` to prevent accidental commit of the PAT file.

## Verification

1. **Token stripping (without Docker):** Run `bun start`, ask Claude in a channel to `echo $SLACK_BOT_TOKEN` — should be empty
2. **Docker build:** `docker compose build` — completes without errors
3. **Docker run:** `docker compose up` — entrypoint clones repos, Claudeway connects to Slack via Socket Mode
4. **Docker restart:** `docker compose restart` — entrypoint pulls (fast), Claudeway starts
5. **Token isolation:** Ask Claude to `cat /app/.env` (file doesn't exist) or `env | grep SLACK` (no results)
6. **OAuth token:** Ask Claude to run `env | grep CLAUDE_CODE` — `CLAUDE_CODE_OAUTH_TOKEN` should be present (needed for auth)
7. **Config access:** Ask Claude to read `config.yaml` — works (mounted read-only)
8. **Repo cloning:** Repos defined in `config.yaml` are cloned into `.repos/` on first start
9. **Agent git ops:** Ask Claude to `git pull`, `git checkout feature-branch`, `git status` — works inside `.repos/<name>/`
10. **Multi-repo access:** Ask Claude to `ls ../shared-lib` from primary repo cwd — accessible
11. **Skills:** Ask Claude to list skills — Claudeway bundled skills from `/app/.claude/skills/` + repo-specific skills visible

## Gotchas

- **Silent CLI failures:** The Claude CLI can exit with code 0 and produce no output when it hits internal errors (e.g., missing directories, config issues). The stderr warning in `claude.ts` helps diagnose these. If this happens after a fresh `docker compose down -v`, the named volume may need a successful first run for the CLI to create its state directories.
- **Debug directory:** The Dockerfile creates `/home/claudeway/.claude/debug/` explicitly. The CLI writes error logs there and crashes with an ENOENT error if it's missing — this cascading error masks the real problem (e.g., a 403 from an expired OAuth token). The named volume at `/home/claudeway/.claude` is seeded from the image on first creation, so the directory persists.
