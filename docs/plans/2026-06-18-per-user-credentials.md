# Per-User Credentials (Claude / Jira / GitHub) via Web Form

## Context

Today claudeway runs every subprocess as the **owner**: `claude -p` authenticates with the owner's Claude Max OAuth in `~/.claude` (inherited via `HOME`), Jira creds are a single shared service account hardcoded in [mcp.json](../../mcp.json), and GitHub has no per-user support. Actions by different Slack users are indistinguishable at the service level and all bill/attribute to the owner.

We want each Slack user to supply **their own** tokens for `claude -p`, Jira, and GitHub, so work runs on (and is attributed to) the right person's accounts.

**This is a deliberate shift to a multi-user gateway.** Per-user Claude credentials contradict [CLAUDE.md](../../CLAUDE.md)'s current primary principle ("does not operate as a multi-user service"). That principle must be revised: each user authenticates with **their own** subscription/key — arguably *more* ToS-aligned than borrowing the owner's — while keeping the no-token-extraction / no-third-party-routing guarantees intact.

### Decisions locked in
- **Credentials in scope:** per-user Claude (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), Jira, GitHub.
- **Who sets:** each user sets their own, keyed by Slack `userId`.
- **Delivery:** a **web form** (Slack DM token-pasting rejected as too exposed). `!creds` DM returns a per-user magic link.
- **At-rest storage:** AES-256-GCM encrypted, gitignored store, single symmetric server key via built-in `node:crypto` (no new dependency). Key kept separate from the store.
- **Transit:** token entered directly in the web form (never transits Slack). Plain HTTP on LAN/VPN today; HTTPS required if exposed publicly (tunnel provides it).
- **Form exposure (default, overridable):** build against the existing server now; LAN-only vs tunnel deferred to a `BASE_URL` deployment toggle.
- **Magic-link token (default, overridable):** in-memory `randomUUID()` → `userId` map, single-use, ~10 min TTL. No signing key; links die on restart (re-run `!creds`).
- **Credential model:** generic, config-driven registry (not hardcoded to Jira/GitHub/Claude). Each cred has a **shared default + optional per-user override**, with the default policy decided per credential.
- **Auth method:** PAT paste in the web form first (uniform across all cred types). OAuth flows are a per-provider follow-up that reuses the same web-form/`BASE_URL`/callback infra.

## Credential model (generic, config-driven)

Define a credential registry in `config.yaml`, mirroring the existing `permissions.<name>.env` structure:

```yaml
userCredentials:
  jira:
    label: "Jira API token"
    env: [JIRA_API_TOKEN]        # subprocess env var(s) the user's value fills
    default: shared              # fall back to process.env shared value if user hasn't set
    requiresPermission: jiraWrite
  github:
    label: "GitHub token"
    env: [GH_TOKEN, GITHUB_TOKEN]
    default: none
    requiresPermission: git
  claude:
    label: "Claude OAuth token"
    env: [CLAUDE_CODE_OAUTH_TOKEN]
    default: none
```

- **Per-cred default policy:**
  - **Jira** → `shared`: keep today's service-account creds (from [mcp.json](../../mcp.json)/`process.env`) as the fallback, so users who never set their own still work; a personal token gives correct attribution.
  - **GitHub/git** → `none` initially: the server already clones/pulls via `syncRepos()` with the owner's creds, so a default is only needed for mid-session git fetches. Write-capable users set their own.
  - **Claude** → `none` (each user sets their own); a shared default reintroduces the "borrow the owner's subscription" pattern. Optional owner-only fallback.
- **Resolution precedence** (in `buildAllowedEnv`): `user secret > configured default (process.env) > unset`.
- The web form renders its fields from this registry; adding a new cred type (e.g. `langfuse`) is a config edit, no code change.

## Approach (high level)

### 1. Secret store (`src/secrets.ts` — new)
- Gitignored file `.secrets/user-credentials.json`, `chmod 600`, atomic temp+rename writes (mirror `saveConfig()` in [src/config.ts](../../src/config.ts)).
- Shape: `{ [userId]: { [credName]: <AES-256-GCM ciphertext + iv + tag> } }`. Cred names map to env var names.
- Symmetric key from a gitignored source (`CLAUDEWAY_SECRETS_KEY` env var or separate key file), loaded once at startup, kept separate from the store.
- API: `setUserSecret(userId, name, value)`, `getUserSecrets(userId): Record<string,string>` (decrypts), `deleteUserSecret(...)`, `listUserSecretNames(userId)` (names only, never values).
- Add `.secrets/` and the key file to [.gitignore](../../.gitignore).

### 2. Magic-link issuance — `!creds` Slack DM command ([src/adapters/slack/](../../src/adapters/slack/))
- New command parsed alongside the existing `!model:`/`!effort:` overrides in [handler.ts](../../src/adapters/slack/handler.ts) and dispatched via `commands.ts`.
- **DM-only** and **self-scoped**: generates a single-use token bound to the sender's `userId`, DMs back `${BASE_URL}/creds?t=<token>`. DMs are currently botOwner-only ([handler.ts](../../src/adapters/slack/handler.ts) ~253-263) — relax so any allowed user may DM, but strictly scope non-owner DM capability to `!creds`.
- In-memory token map with TTL + single-use invalidation. Reuse the existing auth rate-limiter pattern ([src/adapters/voice/index.ts:23-50](../../src/adapters/voice/index.ts#L23-L50)) on the redeem endpoint.

### 3. Web form + endpoints (mount on existing `Bun.serve`)
- The voice adapter already serves HTTP via `Bun.serve` on `0.0.0.0:8765` with a static test-UI pattern ([src/adapters/voice/index.ts:112-173](../../src/adapters/voice/index.ts#L112-L173)). Add routes there (or a small dedicated server gated by config if we don't want to couple to `voiceServer.enabled`):
  - `GET /creds?t=<token>` → validate token → resolve `userId` → serve the form (static HTML like the test-UI, listing which creds are set via `listUserSecretNames`, never values).
  - `POST /creds` → validate token (single-use) → `setUserSecret` for submitted fields → invalidate token → confirm.
- Add `BASE_URL` (or `publicUrl`) to config so the bot can build the link; document LAN vs tunnel + HTTPS expectations.

### 4. Wire secrets into the subprocess env ([src/claude.ts](../../src/claude.ts))
- In `buildAllowedEnv()` (~460-487), resolve each cred in the `userCredentials` registry with precedence `user secret > configured default > unset`, and inject as its mapped env var name(s) at **highest precedence** (after baseline/global/permission-linked).
- Mappings come from the registry (see "Credential model") rather than being hardcoded; `requiresPermission` gates whether a user may set/use a given cred.
- Extend `AllowedEnvContext` to carry `userId` (or pre-resolved secrets) so the engine passes them through from `processQueuedMessage` in [src/core/engine.ts](../../src/core/engine.ts).

### 5. Per-user Claude auth isolation
- Setting `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` overrides the inherited `~/.claude` login for that subprocess.
- **Session/HOME caveat:** sessions live under `$HOME/.claude/projects/...` with deterministic session IDs (channel+folder+thread). Mixing users' subscriptions under one shared `HOME` works functionally but isn't cleanly isolated. Start with shared HOME + per-user token override; flag **per-user HOME** as a follow-up if isolation matters.

### 6. Per-user Jira / GitHub
- **Jira:** make the Jira MCP server in [mcp.json](../../mcp.json) read `JIRA_*` from the (now per-user) env instead of hardcoded values, so the user's token flows through. Reconcile with read-only MCP selection in [src/mcp.ts](../../src/mcp.ts) (`getMcpConfigPath`, `jiraWrite` gating).
- **GitHub:** inject `GH_TOKEN`/`GITHUB_TOKEN` so `gh`/`git` use the user's token. Define the relationship with the existing git-credential stripping for non-`git` users ([src/claude.ts](../../src/claude.ts) `buildGitReadOnlyEnv` ~386-397) — a user with a GitHub token likely needs `git` permission too.

### 7. Persistent-mode identity ([src/claude.ts](../../src/claude.ts) `processIdentityKey` ~515-526)
- The identity key includes userId/permissions/env-var-**names**/model/effort but **not credential values**. Add a hash/version of the user's resolved secrets so the persistent process **respawns** when a user changes a token. Hash only — never put token values in the key.

### 8. Docs / principle update
- Revise [CLAUDE.md](../../CLAUDE.md) "Primary Design Principle" to reflect multi-user-with-own-credentials.
- Document new Slack scopes (DM + `chat:write`), `CLAUDEWAY_SECRETS_KEY`, `BASE_URL`, exposure/HTTPS guidance, and the `!creds` flow.

## Files
- **New:** `src/secrets.ts`, web-form HTML asset, this plan.
- **Modify:** [src/claude.ts](../../src/claude.ts) (`buildAllowedEnv`, `AllowedEnvContext`, `processIdentityKey`), [src/core/engine.ts](../../src/core/engine.ts) (pass userId/secrets), [src/adapters/slack/handler.ts](../../src/adapters/slack/handler.ts) + `commands.ts` (`!creds`, DM relaxation), [src/adapters/voice/index.ts](../../src/adapters/voice/index.ts) (or new server: form routes), [src/config.ts](../../src/config.ts) (`BASE_URL`/`publicUrl`), [src/mcp.ts](../../src/mcp.ts) / [mcp.json](../../mcp.json), [.gitignore](../../.gitignore), [CLAUDE.md](../../CLAUDE.md), setup docs.

## Verification
- **Unit:** encrypt/decrypt round-trip in `src/secrets.ts`; magic-link token issue → redeem → single-use invalidation + TTL expiry; `buildAllowedEnv` injects user secrets with correct precedence and only for the right `userId` (extend `env-allowlist.test.ts`); `processIdentityKey` changes when a secret changes.
- **Manual:** DM `!creds` → receive link → open form → submit a Jira token → confirm store file is encrypted (not plaintext) and `chmod 600`. Run a Jira write in a channel and confirm attribution to that user. Repeat for GitHub (`gh auth status` / a push attributed to the user) and Claude (subprocess uses the user's token, not the owner's).
- **Negative:** expired/reused link rejected; a user can only set their own creds; `!creds` rejected outside DMs; user with no stored Claude token falls back correctly or is told to set one.
- **Persistent mode:** change a token mid-thread → process respawns with the new credential.

## Open follow-ups (not in initial scope)
- Per-user HOME for full Claude session isolation.
- Tunnel/HTTPS deployment if remote (non-LAN) Slack users need the form.
- HMAC-signed stateless magic-link tokens (survive restarts) if in-memory proves limiting.
- **OAuth flows (per provider)** instead of PATs — reuses the web-form/`BASE_URL`/callback infra. Requires per-provider app registration, refresh-token handling, and (for Jira) switching `mcp-atlassian` from basic auth to OAuth 3LO.
- Token rotation/expiry reminders.
