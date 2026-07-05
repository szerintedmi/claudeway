# Deployment

## macOS LaunchAgent

The install script sets up a LaunchAgent that starts Claudeway on login and restarts it on crashes (10s throttle; clean `SIGTERM`/`SIGINT` exits stay stopped). It auto-detects your `bun` path, project directory, and user environment.

```bash
./scripts/install.sh      # install + start
./scripts/uninstall.sh    # stop + remove
```

Useful commands:

```bash
launchctl list | grep claudeway                                # status
tail -f claudeway.log                                          # logs
launchctl unload ~/Library/LaunchAgents/com.claudeway.plist    # stop temporarily
launchctl load -w ~/Library/LaunchAgents/com.claudeway.plist   # start again
```

## Docker

Docker provides filesystem isolation — the Claude CLI only sees repos defined in `config.yaml`. For how the container is put together (what's mounted, the env model, git auth, persistence), see [docker.md](docker.md).

1. Define repos in `config.yaml` and map channels to them. Repos are cloned/pulled on every startup.
2. Make sure `baseUrl` points at a host/port reachable from users' browsers and the creds form port (default 8791) is published — after the container is up, each user enrolls via `!creds` as usual.
3. Git access uses a GitHub PAT over HTTPS. Two things are required:
   - A `userCredentials` entry in `config.yaml` mapping the token to git (the `github` block in `config.example.yaml` is the template):
     ```yaml
     userCredentials:
       github:
         exposeAs: git-credential-helper
         fields:
           GITHUB_TOKEN:
             defaultFromEnv: SHARED_GITHUB_TOKEN
     ```
   - `SHARED_GITHUB_TOKEN` in `.env` — a fine-grained PAT with **Contents: Read** on every repo in `config.yaml` (**Read and write** for commits/PRs).

   Without the mapping the token is ignored and private clones fail. SSH-form repo URLs (`git@github.com:…`) are served over HTTPS via the credential helper. A user who enrolls a personal GitHub PAT through `!creds` uses it for their own turns.
4. (Optional) Include Claude CLI skills in the image:
   ```bash
   cp docker-skills.conf.example docker-skills.conf
   # add paths to your global skills (one per line), then:
   bash scripts/docker-build.sh
   ```
   Without skills, `docker compose build` works directly.
5. Start:
   ```bash
   docker compose up -d
   ```

Session state, repos, queue, and per-session working files persist across container recreation. `docker-compose.yml` bind-mounts `./.docker` (repos, queue) and `./.docker/claudeway-tmp` → `/app/.claudeway-tmp` (the per-session temp base: inbound downloads, generated files, tool temp, attachment manifests), plus the `claudeway-claude-state` named volume (Claude CLI session transcripts) and `./.secrets` (credential store).

Note: Claude's `$TMPDIR` points at `<session>/tmp` under this bind-mounted temp base, so generic tool scratch (`mktemp`, Python `tempfile`, …) lands on disk under the mount rather than the 100 MB `/tmp` tmpfs. If you want a cap on tool scratch, size the temp volume or keep a tmpfs for `<session>/tmp`.

**Env var security:** `docker-compose.yml` lists env vars explicitly (what enters the container); `config.yaml` controls what reaches the Claude subprocess or tool adapters. Prefer `userCredentials` for API keys/tokens so shared defaults and per-user overrides are declared in one place.

## Running locally with a Cloudflare tunnel

The recommended way to run locally while reachable from outside (Android app, Meta glasses, `!creds` enrollment links) is `caffeinate` (prevents macOS sleep) + a named Cloudflare tunnel:

```bash
caffeinate -i bash -c 'bun run start & cloudflared tunnel run claudeway & wait'
```

Route both servers through one hostname in `~/.cloudflared/config.yml` — the creds form (8791) by path, everything else to the voice server (8765):

```yaml
ingress:
  # credential enrollment form (separate server on 8791)
  - hostname: claudeway.yourdomain.com
    path: ^/creds
    service: http://localhost:8791
  # voice web UI + WebSocket — everything else on this host
  - hostname: claudeway.yourdomain.com
    service: http://localhost:8765
  - service: http_status:404
```

Set `baseUrl: "https://claudeway.yourdomain.com"` in `config.yaml` so `!creds` magic links point at the tunnel. Full tunnel setup (create, DNS route, Cloudflare Access): [cloudflare.md](cloudflare.md). For dev, swap in `bun run dev` for auto-reload.
