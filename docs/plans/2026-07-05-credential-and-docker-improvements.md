# Credential management & Docker: improvement recommendations

Date: 2026-07-05
Status: Proposed
Context: findings from a code review done alongside the BigQuery plan
([2026-07-05-bigquery-per-user-credentials.md](2026-07-05-bigquery-per-user-credentials.md)).
Threat model: trusted internal environment (employees) — goal is no credential
leakage + reasonable hardening, not defense against malicious operators.

## Credential management — genericity

1. **Git credential helper is GitHub-only.** `GIT_CREDENTIAL_USERNAME =
   'x-access-token'` (`src/credentials.ts:13`) and `buildGitConfig` hardcode
   `github.com` URLs and the `[credential "https://github.com"]` scope
   (`src/git-credentials.ts:64-74`). Make host + username config-driven
   (`userCredentials.<name>.git: {host, username}`) so GitLab/Bitbucket/
   self-hosted work without code changes. Low effort, high genericity win.
2. **Extract a shared secret-file primitive.** The BigQuery plan's
   `exposeAs: file` and the existing git-credential file share the same
   pattern (0600 file, sha256 handle, reuse, startup wipe). One
   `materializeSecretFile()` helper, two thin consumers — avoids the
   two-near-identical-modules trap. (Folded into the BigQuery plan §3.)
3. **Git author email domain hardcoded** to `@<channel>.slack`
   (`src/claude-spawn-env.ts:40-43`, existing TODO) — voice-adapter commits get
   a `.slack` email. Parameterize per adapter.

## Credential management — UX

4. **Magic links die on restart.** Links are in-memory with a 10-min TTL
   (`src/creds-links.ts`); any restart (config change, deploy) invalidates every
   pending link and the user just sees "Link expired". Move to HMAC-signed
   stateless links (keyed off the existing secrets master key, TTL embedded) —
   already flagged as "Future #6" in the code; worth prioritizing since it's the
   main enrollment friction.
5. **Form has zero field-level validation** — any non-empty string is stored
   and fails opaquely at use time. The BigQuery plan adds JSON validation;
   generalize into a per-field-type validation hook (e.g. optional
   `type`/`pattern` on `CredentialFieldDef`) with inline error feedback, so a
   mispasted GitHub PAT or Jira token is caught at enrollment.
6. **Post-enrollment confirmation.** After a successful save, show which
   credentials are now personal vs still shared (reuse `CredentialStatus`) so
   users know what changed — cheap reuse of `buildCredentialStatus` data.

## Docker

7. **Fresh-clone build is broken.** `docker-compose.yml` defaults the skills
   build context to `./.docker/skills-empty`, which is gitignored and never
   created — `docker compose up --build` on a fresh checkout fails at
   `COPY --from=skills`. Fix: create it in compose/docs/Makefile, or commit a
   `.gitkeep`-style placeholder outside `.docker/`.
8. **Add `cap_drop: [ALL]`** next to the existing `no-new-privileges` — free
   hardening, nothing in the container needs capabilities.
9. **Pin the container uid** (`useradd -u 1000` or compose `user:`) so the
   bind-mounted `.secrets`/`.docker` ownership is deterministic across hosts
   instead of "usually 1000".
10. **Accepted risk (document, don't fix):** all env secrets (`SLACK_*`,
    `CLAUDEWAY_SECRETS_KEY`, `SHARED_*`) are visible via `docker inspect` /
    `docker compose config` to anyone with Docker socket access. Inherent to
    the compose `environment:` model; file-based secrets add real complexity
    for little gain in a trusted single-host deployment. Note it in
    docs/docker.md instead.
11. **Add a healthcheck** — `restart: unless-stopped` can't recover a
    hung-but-alive process. Minor.

## Doc fixes (trivial)

- CLAUDE.md says `buildAllowedEnv` lives in `src/claude.ts`; it's in
  `src/claude-spawn-env.ts` (re-exported from `claude.ts`).
- docs/docker.md says "~14 named vars"; the compose list is 16.

## Suggested order

7 (build breakage) → 8/9 (one-line hardening) → doc fixes → 1 + 2 (genericity,
do alongside the BigQuery `exposeAs: file` work) → 4/5/6 (enrollment UX) → 11.
