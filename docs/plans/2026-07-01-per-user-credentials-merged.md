# Per-User Credentials — Merged Plan (Implementation + Security Hardening)

**Date:** 2026-07-01

**Status:** Draft

**Supersedes / merges:**
- [2026-06-18-per-user-credentials.md](2026-06-18-per-user-credentials.md) — codebase-grounded implementation plan (delivery vehicle)
- [2026-06-30-byo-credentials-slack-brain-design.md](2026-06-30-byo-credentials-slack-brain-design.md) — architecture & threat-model design (security spec)

## Context

Each Slack user should supply **their own** tokens for `claude -p`, Jira, and GitHub so downstream actions run under (and are attributed to) the right person's accounts. Two prior plans exist; this plan merges them:

- The Jun-18 plan knows the codebase but is thin on security (no audit log, no scrubbing, shared-write fallback, master key in env var, no offboarding).
- The Jun-30 design has the threat model but assumes a warm single-process architecture claudeway doesn't have.

**Key architectural insight (validated against the code):** claudeway spawns `claude -p` per message with a constructed env ([src/claude.ts:544-550](../../src/claude.ts#L544-L550)), and persistent mode already respawns on identity change ([src/claude.ts:1316-1331](../../src/claude.ts#L1316-L1331)). Per-user credentials therefore need **no credential broker and no custom tool wrappers** — the Jun-30 doc's Approach A machinery exists only to work around a warm-process constraint that claudeway's spawn-per-message model dissolves. Stock MCP servers work per-user via env injection. What we take from Jun-30 instead is its **controls**: the fallback policy (Q5), audit log, secret scrubbing, least-privilege guidance, revocation, and the named upgrade paths for the risks the MVP accepts.

**ToS note (carried from Jun-18):** this is a deliberate shift to multi-user-with-own-credentials. [CLAUDE.md](../../CLAUDE.md)'s "does not operate as a multi-user service" principle must be revised: each user authenticates with their **own** subscription/key (arguably more ToS-aligned than borrowing the owner's), keeping the no-token-extraction / no-third-party-routing guarantees.

## Decisions

### Inherited from Jun-18 (unchanged)
- **Scope:** per-user Claude (`CLAUDE_CODE_OAUTH_TOKEN`), Jira, GitHub; generic config-driven registry so new cred types are config-only.
- **Delivery:** web form via `!creds` DM magic link (single-use, ~10 min TTL, in-memory). Secrets never pasted into Slack messages.
- **Auth method:** PAT paste first; OAuth flows are a follow-up reusing the same infra.
- **At-rest storage:** AES-256-GCM via `node:crypto`, gitignored store, key separate from store.

### Adopted from Jun-30 (overriding Jun-18 where they conflicted)
1. **No shared-identity writes for unenrolled users** (Jun-30 Q5, resolved). Jun-18's Jira `default: shared` allowed unenrolled `jiraWrite` users to write as the service account — the exact attribution bug this feature exists to fix. **Merged policy:** shared fallback covers **reads only**; any write path requires the user's own credential. Concretely: full `mcp.json` (write-capable) is selected only when the user has `jiraWrite` **and** a personal Jira token; otherwise they get `mcp-readonly.json` ([src/mcp.ts:55-75](../../src/mcp.ts#L55-L75)). The reply tells unenrolled users they're in limited mode with the `!creds` hint (once per thread).
2. **Audit log** — every credentialed spawn and every enrollment event is recorded (names, never values). Answers "whose credentials executed this?"
3. **Secret scrubbing** — decrypted values are scrubbed from anything logged or surfaced. Validated leak paths today: persistent-mode stderr logged in real time ([src/claude.ts:1143](../../src/claude.ts#L1143)) and exit-error messages embedding stderr ([src/claude.ts:612-614](../../src/claude.ts#L612-L614)).
4. **Least-privilege enrollment guidance** — the form instructs users to mint scoped tokens (project-scoped Jira, fine-grained GitHub PAT, read-only where possible). Bounds the store's blast radius.
5. **Revocation & offboarding** — users can delete their own creds; botOwner can list enrolled users and revoke anyone's (Slack user leaves → one command).
6. **Store behind an interface** — the AES-GCM file backend implements a minimal `SecretStore` interface (`get/set/delete/listNames`) so a keychain/KMS backend is a drop-in later (Jun-30 §6), without adopting sops/age now.

### Added in review (2026-07-01)
7. **Git gets the same tiered fallback as Jira.** Three tiers: no personal token → **shared read-scoped token** (fine-grained PAT with read-only contents scope, or deploy token) so `git fetch`/`pull` work for everyone — enforcement is the token's own scope, no claudeway logic; `git` permission + personal token → full read/write as the user (commits already attributed via `buildGitAuthorEnv()`, [src/claude.ts:416-425](../../src/claude.ts#L416-L425)); botOwner → own creds, unchanged. This replaces `buildGitReadOnlyEnv()`'s block-everything behavior ([src/claude.ts:402-413](../../src/claude.ts#L402-L413)) with "authenticate as the shared read-only token".
8. **Git credentials via per-spawn gitconfig + credential helper, not env vars.** Repos are cloned over SSH (`git@github.com:` URLs in config) but PATs are HTTPS-only: generate a per-spawn `GIT_CONFIG_GLOBAL` file (we already control this var) containing `url.https://github.com/.insteadOf=git@github.com:` plus a credential helper that emits the resolved token (user's or shared RO). Tokens stay out of remote URLs, disk, and — for git — out of the subprocess env entirely. This delivers the "credential-helper indirection" future item early for git.
9. **Worktree per Slack thread.** First message in a thread lazily runs `git worktree add` on branch `wt/<channel>/<threadTs>`; every turn in that thread runs there regardless of sender, so participants share files within a thread while each turn's commits/pushes carry that turn's author and token. Bonus: isolates threads from each other (an existing collision class in the shared checkout). Top-level (non-thread) messages keep using the main checkout. Worktrees are GC'd by age. **Caveat:** `deriveSessionId()`'s `folder` input ([src/claude.ts:200-202](../../src/claude.ts#L200-L202)) stays the *logical* repo folder, not the worktree path — otherwise every existing session ID changes.
10. **Canonical `users:` registry in config.** People are defined once (name, Slack ID, voice ID, permissions); channels reference members by name. The secret store, audit log, and process identity key on the **canonical user id** (stable across a person's Slack and voice identities). The old `allowedUsers` shape keeps parsing with a deprecation warning.

### Accepted risks (explicit, with named upgrade paths — not oversights)
- **Master key in `CLAUDEWAY_SECRETS_KEY` env var / key file.** Jun-30 correctly flags this as a single point of compromise. Accepted for a LAN, single-host MVP. Upgrade path: macOS Keychain unseal now / KMS or systemd-creds on a future Ubuntu host, behind the `SecretStore` interface (Future #3).
- **Model-visible secrets.** Injected env vars are readable by the subprocess (and anything it runs). Since the subprocess acts *as that user with that user's own tokens*, self-exfiltration is low-stakes; the real risk is prompt injection via untrusted content (a malicious Jira ticket / repo file) exfiltrating a token. Mitigations in MVP: least-privilege tokens (#4), audit (#2), scrubbing (#3). Full fix is credential-helper indirection (Future #4).
- **Magic link transits Slack DM.** The link (not the secret) is retained by Slack. Mitigated by single-use + short TTL + random 128-bit token; redemption over plain HTTP is LAN/VPN-only until HTTPS exposure (Future #6).
- **Shared HOME / session history.** Users' sessions share the owner's `~/.claude` (deterministic session IDs, [src/claude.ts:200-202](../../src/claude.ts#L200-L202)); per-user token overrides auth but not session isolation. Acknowledged; per-user HOME is Future #5.
- **Claude fallback = owner's login.** Unenrolled users continue to run on the owner's `~/.claude` auth (inherited via `HOME`), i.e. today's behavior — consistent with Jun-30 Q1(a) "org pays for the AI, the human owns the actions". A personal `CLAUDE_CODE_OAUTH_TOKEN` overrides it when set.

## Credential model (config-driven registry)

Storage, enrollment, and resolution are fully generic. The only service-specific piece is a small **enforcement adapter** — how the resolved credential reaches the subprocess and what capability it unlocks:

| Service | Enforcement adapter |
|---|---|
| Jira | MCP config selection (full vs read-only) + `${VAR}` env passthrough |
| git/GitHub | per-spawn gitconfig + credential helper (decision #8) — no env vars |
| everything else (default) | plain env injection via `buildAllowedEnv()` |

```yaml
userCredentials:
  jira:
    label: "Jira API token"
    env: [JIRA_API_TOKEN, JIRA_USERNAME]   # username+token pair; form renders both fields
    fallback: shared                       # shared service account; write MCP config still needs a personal token
    requiresPermission: jiraWrite          # gates who may SET it (setting implies write intent)
  github:
    label: "GitHub fine-grained PAT"
    inject: git-credential-helper         # enforcement adapter, not env (decision #8)
    fallback: shared                      # shared READ-scoped PAT/deploy token
    requiresPermission: git               # gates personal (write) tokens; shared read needs no permission
  claude:
    label: "Claude Code OAuth token"
    env: [CLAUDE_CODE_OAUTH_TOKEN]
    fallback: owner-login                  # documented: inherited ~/.claude auth
```

- `fallback` values: `shared` (fall back to an org-owned credential from `process.env`), `none` (capability absent without a personal token), `owner-login` (Claude only).
- **Policy rule replacing per-service special cases:** a `shared` fallback credential MUST be read-scoped — read-only Jira via the read-only MCP config, read-scoped GitHub PAT by token scope. Write capability always requires the user's own credential (merged Q5). Enforcement is by token scope where the provider supports it, by adapter (MCP config) where it doesn't.
- Resolution precedence: **user secret > shared fallback (read-scoped) > unset**.
- The web form renders its fields from this registry; adding `langfuse` etc. is a config edit needing no adapter.

## MVP scope

### 1. `users:` registry + config restructure ([src/config.ts](../../src/config.ts))
- Top-level `users:` section as the canonical person registry; channels reference members by name:

  ```yaml
  users:
    petro:  { slack: U0AAPNBEX1A, voice: voice-petro, permissions: [git, jiraWrite, langfuse] }
    val:    { slack: U0AA4LKCS4F, permissions: [langfuse] }

  channels:
    C0AHQM3CCJ1:
      name: test-copilot-brain2
      repo: copilot-brain
      members: [val, oskar]              # per-channel override: [{ oskar: [git] }]
  ```

- Fixes existing config pain independent of this feature: permission arrays repeated per user per channel, names living only in comments, one person split across Slack and voice identities.
- Resolution: `slack`/`voice` id → canonical user id → permissions (channel `members` entry may override/extend). Git author name comes from the registry instead of a Slack profile lookup.
- **Backward compatibility:** old `allowedUsers` shape (and `voiceServer.auth.tokens[].userId`) keeps parsing with a deprecation warning; migrate `config.yaml` alongside.

### 2. Secret store — `src/secrets.ts` (new)
- Keyed by **canonical user id** (from the `users:` registry), so a person's Slack and voice turns resolve the same credentials.
- `SecretStore` interface: `set(userId, name, value)`, `getAll(userId)` (decrypts), `delete(userId, name?)`, `listNames(userId)` (names only), `listUsers()` (for offboarding).
- File backend: `.secrets/user-credentials.json`, AES-256-GCM (`node:crypto`), per-entry `{ciphertext, iv, tag}`, `chmod 600`, atomic temp+validate+rename mirroring `saveConfig()` ([src/config.ts:292-308](../../src/config.ts#L292-L308)).
- Key from `CLAUDEWAY_SECRETS_KEY` (or gitignored key file), loaded once at startup; refuse to start credential features without it.
- Add `.secrets/` + key file to [.gitignore](../../.gitignore) (currently absent — validated).

### 3. `!creds` Slack DM command
- Parse alongside existing magic commands in [src/adapters/slack/commands.ts:290-296](../../src/adapters/slack/commands.ts#L290-L296); sender identity is `msg.user` from the Bolt-verified event payload ([src/adapters/slack/handler.ts:290](../../src/adapters/slack/handler.ts#L290)) — never message text.
- **DM-only, self-scoped.** Relax the botOwner-only DM gate ([handler.ts:254-263](../../src/adapters/slack/handler.ts#L254-L263)) so any user allowed in ≥1 configured channel may DM, but non-owner DM capability is strictly limited to `!creds` (and its subcommands). Note: [commands.ts:105-106](../../src/adapters/slack/commands.ts#L105-L106) also blocks non-owner DM commands — both gates need the scoped exception.
- Issues `randomUUID()` token → in-memory `{token → canonical userId}` map (sender's Slack id resolved through the `users:` registry), single-use, ~10 min TTL; DMs back `${baseUrl}/creds?t=<token>` (DM plumbing exists — `conversations.open` pattern in [src/adapters/slack/index.ts:7-30](../../src/adapters/slack/index.ts#L7-L30)).
- Subcommands: `!creds` (get link), `!creds list` (own cred names), `!creds revoke <name>|all`. **botOwner-only:** `!creds list @user`, `!creds revoke @user` (offboarding).

### 4. Web form + endpoints
- The voice `Bun.serve` only starts when `voiceServer.enabled` ([src/adapters/voice/index.ts:92-111](../../src/adapters/voice/index.ts#L92-L111)) — validated. Extract a small shared HTTP server (or start the existing one when *either* `voiceServer.enabled` or `credsForm.enabled`), and register routes:
  - `GET /creds?t=<token>` → validate token → serve form (fields from registry, filtered by the user's `requiresPermission`; shows which creds are set via `listNames`, never values, plus least-privilege guidance per service).
  - `POST /creds` → validate + consume token → `set()` submitted fields → confirm.
- Reuse the progressive-backoff rate limiter pattern ([src/adapters/voice/index.ts:23-50](../../src/adapters/voice/index.ts#L23-L50)) on both endpoints.
- New config: `baseUrl` (none exists today — validated) + docs on LAN vs tunnel/HTTPS expectations.

### 5. Env wiring & enforcement adapters — `buildAllowedEnv()` ([src/claude.ts:464-503](../../src/claude.ts#L464-L503))
- Extend `AllowedEnvContext` with the canonical `userId` (currently absent — validated; `userId` already flows through `ClaudeOptions` from [src/core/engine.ts:146-153](../../src/core/engine.ts#L146-L153), so this is plumbing, not redesign).
- Resolve each registry cred with the precedence above and inject at **highest precedence** (after baseline → global `env` → permission-linked → `extraEnv`), gated by `requiresPermission`.
- **Jira adapter:** `mcp.json` currently hardcodes `JIRA_USERNAME`/`JIRA_API_TOKEN` as literals (validated), while the New Relic entry already uses `${NEWRELIC_API_KEY}` interpolation — switch the Jira/Confluence entries to `${VAR}` interpolation so the per-user env flows into the MCP server. Shared service-account values move to `process.env` as the `shared` fallback. Extend `getMcpConfigPath()` ([src/mcp.ts:55-75](../../src/mcp.ts#L55-L75)) — full `mcp.json` requires `jiraWrite` **and** a personal Jira token (decision #1).
- **Git adapter (decisions #7/#8):** replace `buildGitReadOnlyEnv()` hard-blocking ([src/claude.ts:402-413](../../src/claude.ts#L402-L413)) with a generated per-spawn gitconfig: `GIT_CONFIG_GLOBAL` → temp file containing the `insteadOf` SSH→HTTPS rewrite + `credential.helper` pointing at a claudeway helper script that emits the resolved token (personal for `git`-permission enrolled users; shared read-scoped PAT otherwise; owner creds for botOwner). `GIT_SSH_COMMAND=/bin/false` stays (force HTTPS). Git author env unchanged. Tokens never enter the subprocess env or remote URLs.

### 6. Thread worktrees (decision #9) — `src/worktrees.ts` (new)
- Lazily `git worktree add <dir> -b wt/<channel>/<threadTs>` on a thread's first message; engine sets the spawn `cwd` to the worktree while `deriveSessionId()` keeps receiving the logical repo folder (session-ID stability caveat, decision #9).
- Top-level (non-thread) messages keep using the main checkout; `syncRepos()` startup behavior unchanged (worktrees share the object store; fetch benefits all).
- GC: prune worktrees (`git worktree remove` + branch cleanup) whose last activity exceeds `threadWorktreeMaxAgeDays` (new `defaults` key, mirroring `tempMaxAgeDays`); run at startup alongside temp cleanup.
- Serialization: `channelBusy` already serializes per channel; document that concurrent threads on the same repo are now safe (separate worktrees) — an existing collision class this fixes.

### 7. Persistent-mode identity
- `processIdentityKey()` ([src/claude.ts:531-542](../../src/claude.ts#L531-L542)) currently keys on `userId|perms|envNames|model|effort`. Append a **hash** of the user's resolved secret *values* (e.g. SHA-256 over sorted `name=value` pairs) so a token change mid-thread triggers the existing kill/respawn path ([src/claude.ts:1316-1331](../../src/claude.ts#L1316-L1331)). Hash only — never values in the key or logs.

### 8. Security controls (MVP, from Jun-30)
- **Audit log** — append-only JSONL (e.g. `.claudeway-audit.jsonl`, gitignored): `{ts, userId, userName, channelId, event, credNames}` for `spawn` (which cred names were injected), `creds.set`, `creds.deleted`, `link.issued`, `link.redeemed`, `link.rejected`. Names/outcomes only, never values. (Nothing like this exists today — validated; the queue's `userId/queuedAt` is the closest thing.)
- **Scrubbing** — hold the set of decrypted values for the in-flight spawn; pass output through a `scrubSecrets()` replacer before it reaches: persistent stderr console logging ([src/claude.ts:1143](../../src/claude.ts#L1143)), exit-error messages embedding stderr ([src/claude.ts:612-614](../../src/claude.ts#L612-L614)), and any responder-visible error text. Never log spawn env/args (already the case — validated; keep it that way).
- **Limited-mode notice** — once per thread, an unenrolled user attempting a gated capability gets a short "limited mode — connect with `!creds`" note (Jun-30 Q5 UX).

### 9. Docs
- Revise [CLAUDE.md](../../CLAUDE.md) Primary Design Principle (multi-user-with-own-credentials).
- Document `CLAUDEWAY_SECRETS_KEY`, `baseUrl`, exposure/HTTPS guidance, `!creds` flow, least-privilege token recipes per service, offboarding runbook (`!creds revoke @user` + rotate shared fallbacks).
- Document the `users:` registry migration (old `allowedUsers` deprecation), the shared read-scoped git token setup (minting a fine-grained RO PAT), and thread-worktree behavior + `threadWorktreeMaxAgeDays`.

## Future improvements (post-MVP, ordered)

1. **OAuth flows per provider** (Atlassian 3LO, GitHub OAuth) replacing PAT paste — reuses form/`baseUrl`/callback infra; requires app registration, refresh-token storage, and switching `mcp-atlassian` to OAuth. Lazy on-failure refresh first (Jun-30 Q8a).
2. **Token expiry/rotation UX** — on 401/403 from a per-user cred, DM the user a re-enroll link; later proactive refresh for OAuth.
3. **Master-key hardening** — unseal from macOS Keychain now; KMS/systemd-creds/TPM for the Ubuntu host (Jun-30 Phase 3's "master-key bootstrap"). Drop-in behind `SecretStore`.
4. **Credential-helper indirection for remaining services** — git already gets it in MVP (decision #8); extend the pattern (MCP-side token fetch) so Jira/other tokens leave the subprocess env too; pairs with a **token sensitivity policy** (Jun-30 Q7: prod-write tokens get stricter handling or stay off the host).
5. **Per-user HOME / session isolation** — full Claude auth + session separation.
6. **HTTPS/tunnel exposure** for non-LAN users; HMAC-signed stateless magic links (survive restarts).
7. **Per-user Claude billing revisit** (Jun-30 Q1) — org-issued per-user API keys if central billing attribution is ever required.

## Files

- **New:** `src/secrets.ts`, `src/audit.ts` (or fold into secrets), `src/worktrees.ts`, git credential-helper script + per-spawn gitconfig generation, creds form HTML asset, this plan.
- **Modify:** [src/claude.ts](../../src/claude.ts) (`buildAllowedEnv`, `AllowedEnvContext`, `processIdentityKey`, git env → gitconfig adapter, scrubbing at stderr/error sites), [src/core/engine.ts](../../src/core/engine.ts) (canonical userId/secrets, worktree cwd, limited-mode notice), [src/adapters/slack/handler.ts](../../src/adapters/slack/handler.ts) + [commands.ts](../../src/adapters/slack/commands.ts) (`!creds`, scoped DM relaxation at both gates), [src/adapters/voice/index.ts](../../src/adapters/voice/index.ts) or extracted HTTP server (form routes, rate limiter reuse; voice token → canonical user resolution), [src/config.ts](../../src/config.ts) (`users:` registry + back-compat, `userCredentials`, `baseUrl`, `credsForm`, `threadWorktreeMaxAgeDays`), [src/mcp.ts](../../src/mcp.ts) (`getMcpConfigPath` gating) + [mcp.json](../../mcp.json) (`${VAR}` interpolation), [src/sync-repos.ts](../../src/sync-repos.ts) (worktree awareness/GC hook), [.gitignore](../../.gitignore), [CLAUDE.md](../../CLAUDE.md), `config.yaml` migration, setup docs.

## Verification

- **Unit:** AES-GCM round-trip + tamper detection (bad tag); magic-link issue → redeem → single-use + TTL expiry; `buildAllowedEnv` injects the right user's secrets at the right precedence and only with the required permission (extend `env-allowlist.test.ts`); `processIdentityKey` changes when a secret value changes; `getMcpConfigPath` returns read-only without a personal Jira token even for `jiraWrite` users; `scrubSecrets` redacts values from stderr/error strings; audit entries contain names, never values; `users:` registry resolution (Slack id → canonical id → permissions, channel override, old `allowedUsers` back-compat + deprecation warning); generated gitconfig contains the `insteadOf` rewrite and helper reference, never a token literal; worktree module creates lazily, reuses per thread, and GC prunes past `threadWorktreeMaxAgeDays`.
- **Manual:** DM `!creds` → link → form → set Jira token → store file encrypted + `chmod 600`; Jira write in a channel attributed to that user; unenrolled `jiraWrite` user gets read-only Jira + limited-mode note; unenrolled user can `git fetch`/`pull` via the shared RO token but a push is rejected by token scope; enrolled `git` user pushes and the commit/push attribute to them; two users in one thread see each other's files (same worktree) while their turns use their own creds; two concurrent threads on the same repo don't interfere; Claude subprocess uses the user's token (verify via billing/usage, not owner's); persistent thread respawns after a token change; `!creds revoke @user` removes everything and the audit records it.
- **Negative:** expired/reused link rejected (and audited); user cannot set creds gated by a permission they lack; non-owner DM with anything other than `!creds` still refused; forged form POST without a valid token rejected + rate-limited; a token value never appears in console output, error replies, or the audit file (grep test).

## Deltas vs. the two source plans (summary)

| Topic | Jun-18 said | Jun-30 said | This plan |
|---|---|---|---|
| Architecture | env injection per spawn | broker + credential-aware wrappers | env injection (validated: wrappers unnecessary in claudeway) |
| Unenrolled Jira | shared fallback incl. writes | never shared writes (Q5) | shared **reads** only; writes need own token |
| Master key | env var | vault + bootstrap warning | env var accepted for LAN v1, upgrade path named |
| Audit / scrubbing | — | required | in MVP |
| Offboarding | — | revocation runbook | `!creds revoke @user` in MVP |
| Per-user Claude | v1, default none | defer (Q1a) | opt-in v1: personal token overrides owner-login fallback |
| Storage backend | AES-GCM file | sops+age behind interface | AES-GCM file **behind interface** |
| Git for unenrolled | `default: none` (git stays blocked) | — | shared **read-scoped** token; fetch/pull for all, writes need own token |
| Git token delivery | env vars (`GH_TOKEN`) | secrets never model-visible | per-spawn gitconfig + credential helper — token out of env entirely |
| Working tree | shared checkout | — | **worktree per Slack thread** (shared within thread, isolated across threads, age-GC'd) |
| User identity keying | Slack `userId` | Slack `user_id` | canonical `users:` registry (Slack + voice → one person) |
