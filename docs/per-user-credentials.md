# Per-User Credentials — Setup & Operations

Implements [the merged plan](plans/2026-07-01-per-user-credentials-merged.md): each user supplies **their own** tokens for Claude, Jira, and GitHub, so downstream actions run under (and are attributed to) their own accounts.

## Quick start (bot owner)

1. **Master key** — generate 32 bytes and expose it to the server (never commit it):

   ```bash
   openssl rand -hex 32          # → CLAUDEWAY_SECRETS_KEY in .env
   # or: openssl rand -hex 32 > .secrets/key && chmod 600 .secrets/key
   ```

   The key is **required** — the server refuses to start without it (per-user credentials are always on).

2. **Users registry** — define people once, reference them per channel:

   ```yaml
   users:
     petro: { name: "Petro", slack: U0AAPNBEX1A, voice: voice-petro }
     val:   { name: "Val", slack: U0AA4LKCS4F }

   channels:
     C0AHQM3CCJ1:
       name: test-copilot-brain2
       repo: copilot-brain
       members: [val, petro]
   ```

   The registry key (`petro`) is the **canonical user id** — it keys the secret store, audit log, and persistent-process identity, and is stable across a person's Slack and voice identities. The removed legacy `allowedUsers` shape is rejected at config load with a migration hint.

3. **`baseUrl` (required)** — the enrollment form always runs (default port 8791, override via `credsForm.port`); `baseUrl` must be reachable by your users (LAN/VPN; put HTTPS in front before exposing wider). Optional Jira/GitHub/custom credential types go in `userCredentials` — see [config.example.yaml](../config.example.yaml). The `claude` credential is built-in and not configurable.

4. **Jira MCP migration** — replace literal values in `mcp.json` with `${VAR}` interpolation (see [mcp.example.json](../mcp.example.json)):

   ```json
   "JIRA_USERNAME": "${JIRA_USERNAME}", "JIRA_API_TOKEN": "${JIRA_API_TOKEN}"
   ```

   Shared defaults are configured explicitly per field with `defaultFromEnv`:

   ```yaml
   userCredentials:
     jira:
       fields:
         JIRA_USERNAME: { defaultFromEnv: SHARED_JIRA_USERNAME }
         JIRA_API_TOKEN: { defaultFromEnv: SHARED_JIRA_API_TOKEN }
   ```

   This deliberately avoids treating an existing personal `JIRA_API_TOKEN` in `.env` as a shared default.

5. **Shared GitHub token** — mint a fine-grained PAT or deploy token for the repos claudeway serves, export it as the var named by `defaultFromEnv` (e.g. `SHARED_GITHUB_TOKEN`), and expose it with `exposeAs: git-credential-helper`. The token's own scope decides whether users can only fetch/pull or can also push.

## User flow

1. DM the bot `!creds` → receive a single-use link (10-min TTL) to the web form.
2. Paste least-privilege tokens (guidance is shown per service; values are AES-256-GCM encrypted at rest, never shown back). Stored credentials show a per-credential delete checkbox on the same form.
3. Done — subsequent turns use your tokens. In persistent threads, a token change triggers a respawn automatically.

Commands: `!creds` (link) · `!creds list` · `!creds revoke <name>|all` · **owner:** `!creds list @user`, `!creds revoke @user [name|all]`.

## Policy

- **Channel access is the normal boundary.** If a user is allowed to use the bot in a channel, they can use configured shared credential defaults for that channel's work.
- **Shared defaults are explicit.** A shared default exists only when a field maps `defaultFromEnv` to a server env var. Claudeway does not implicitly read the exposed field name from `.env`.
- **Personal credentials override shared defaults.** Values enrolled via `!creds` are used for that user's turns and trigger persistent-process respawn on change.
- **Provider scope controls read/write where tokens can be scoped (GitHub).** Atlassian API tokens are always full-access as their owner, so `userCredentials.<name>.mcpReadOnlyServers` forces the listed MCP servers read-only (`READ_ONLY_MODE=true` in a generated MCP config) whenever that credential doesn't resolve to a personal secret. This is a tool-layer guardrail against accidental writes attributed to the shared token's owner, not a security boundary — the shared token still reaches the subprocess env.
- **The agent is told which tokens are shared.** Each credential can declare a `sharedAccessNote` (e.g. `"read-only — creating or updating Jira issues will fail"`). Users running on a shared default or with no credential get a "Credential status" block appended to the subprocess system prompt, so the agent refuses doomed writes preemptively and points at `!creds` instead of failing mid-task. Users whose credentials are all personal get no block.
- **BYO Claude is built-in and always on**: **every** user — bot owner included — must enroll their own Claude token; unenrolled users' turns are refused with a `!creds` hint (audited as `spawn.denied`). There is no owner-auth fallback — without the hard gate, an "unenrolled" user would silently inherit the owner's `~/.claude` auth. Note: the owner's enrolled `setup-token` token does not auto-refresh like an interactive login (re-enroll when it expires, roughly yearly), and enrollment requires Slack (`!creds` is DM-only) — voice-only users must enroll via Slack first.

## Least-privilege token recipes

- **Jira/Confluence**: API token from id.atlassian.com → Security → API tokens. Prefer a scoped token (Atlassian "API token with scopes") limited to the projects you touch.
- **GitHub**: fine-grained PAT, repository access limited to the repos claudeway serves, permissions `Contents: Read and write` (plus `Pull requests: Read and write` if you use PR flows). Never a classic full-scope PAT.
- **Claude**: `claude setup-token` on your own machine → paste the OAuth token.

## Offboarding runbook

1. `!creds revoke @user` (botOwner, DM) — removes all their stored credentials (audited).
2. Remove them from `users:` / channel `members:`.
3. Rotate shared default tokens if warranted.

## Audit & scrubbing

- `.claudeway-audit.jsonl` (gitignored, 0600) records `spawn`, `spawn.denied`, `creds.set`, `creds.deleted`, `link.issued`, `link.redeemed`, `link.rejected` — credential **names only, never values**.
- Decrypted values are scrubbed (`[redacted]`) from Claude stderr logs, exit-error messages, and error replies.

## Thread worktrees

Repo-backed channels run each Slack thread in its own git worktree under `.docker/worktrees/<repo>/<channel>/<threadTs>` on branch `wt/<channel>/<threadTs>`:

- Participants in one thread share files; each turn's commits/pushes carry that turn's author and token.
- Concurrent threads on the same repo no longer collide (previously a real hazard in the shared checkout).
- The main checkout stays clean for `syncRepos()`; worktrees share the object store, so startup fetches benefit all threads.
- New worktrees start from `origin/<branch>` (the configured `repos.<name>.branch`, else the checkout's current branch) after a throttled `git fetch origin` (at most every 5 min per repo), so fresh threads get the latest remote state regardless of when the gateway last restarted. Offline or origin-less repos fall back to the local HEAD. Existing thread worktrees are never updated mid-conversation.
- Idle worktrees (and their `wt/*` branches) are pruned at startup after `defaults.threadWorktreeMaxAgeDays` (default 14; `0` disables). Worktrees with uncommitted changes or commits unreachable from any other branch/remote are kept regardless of age (logged; remove manually to reclaim).
- Session IDs still derive from the logical repo folder, so existing session IDs stay stable. Note: the Claude CLI stores session transcripts keyed by the actual cwd, so threads that existed *before* enabling worktrees start a fresh transcript on their next message.
- **Every conversation root gets a worktree** (not just replies): the Claude CLI keys transcripts by cwd, so a conversation must live in one cwd from its very first turn — moving into a worktree at the first reply would drop the root turn's context. The cost is one worktree per conversation on repo-backed channels; the age GC bounds it, and busy Q&A channels can opt out entirely with `threadWorktrees: false` (per channel or in `defaults`).

## Accepted risks (explicit, with upgrade paths)

- **Master key in env/key file** — accepted for a LAN, single-host MVP. Upgrade: keychain/KMS behind the `SecretStore` interface.
- **Model-visible secrets** — env-injected values are readable by the subprocess; since it acts as that user with that user's own least-privilege tokens, self-exfiltration is low-stakes. The real risk is prompt injection via untrusted content; mitigations: least-privilege tokens, audit, scrubbing. Full fix: credential-helper indirection for all services.
- **Git token on disk (0600)** — the per-spawn gitconfig never contains a token literal; the helper reads a `0600` file under `.secrets/git-credentials/` (wiped at startup). Same model-visible surface as `git credential fill`; full indirection is a future item.
- **Magic link transits Slack DM** — the link (not the secret) is retained by Slack; single-use + 10-min TTL + random 128-bit token. Links don't survive restarts.
- **Shared HOME / session history** — users share the owner's `~/.claude` session store; per-user HOME is a future item.
