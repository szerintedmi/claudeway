# BigQuery (`bq` CLI) with per-user credentials

Date: 2026-07-05
Status: Proposed

## Problem

We want the agent to run BigQuery queries through the `bq` CLI, following the
**same credential model as every other provider**: a shared **read-only**
default that works out of the box, **overridable per-user via `!creds`** so a
person's own queries run under (and are attributed to) their own Google
identity.

Two obstacles:

1. **`bq` isn't in the image.** It ships only inside the Google Cloud SDK, so
   the Dockerfile needs a `gcloud`/`bq` install step.
2. **`bq` authenticates from a *file*, not an env string.** It reads a
   service-account JSON key via `GOOGLE_APPLICATION_CREDENTIALS=<path>` (or ADC
   under `~/.config/gcloud`). Claudeway's two existing credential delivery
   mechanisms are:
   - `exposeAs: env` — injects **string** env vars into the subprocess
     (`src/credentials.ts`, applied as `userCredEnv` in `buildAllowedEnv`).
   - `exposeAs: git-credential-helper` — materializes a per-spawn gitconfig +
     0600 credential file under `.secrets/` and injects `GIT_CONFIG_GLOBAL`
     (`src/git-credentials.ts`, wired in `buildGitEnv` in
     `src/claude-spawn-env.ts`).

   Neither delivers a **generic credential file**. BigQuery needs exactly that,
   so this plan adds a third delivery mechanism.

## Goals

- `bq` available on the subprocess PATH in Docker.
- A `bigquery` entry in the `users:`/`userCredentials:` registry that resolves
  with the standard precedence: **personal secret > explicit shared default >
  unset** (already implemented in `resolveUserCredentials`).
- Shared default is a **read-only** service account; personal enrollment via
  `!creds` unlocks a user's own (possibly write-capable) identity.
- The resolved SA key JSON never enters the subprocess env, never lands in git,
  and is scrubbed from logs/errors — same guarantees as the git token.
- Mid-thread key/identity change triggers the existing persistent-process
  respawn (already covered by `secretsHash` in `processIdentityKey`).

## Non-goals

- **Tool-layer read-only enforcement.** BigQuery access is governed by GCP IAM
  on the SA, not a token scope or an MCP `READ_ONLY_MODE` flag. "Read-only" is a
  property of the *shared SA's roles*, declared to the agent via
  `sharedAccessNote` (as with the shared GitHub PAT). We do not intercept `bq`
  invocations. See Security below.
- **Non-key auth** (user OAuth refresh tokens, ADC login flows, Workload
  Identity Federation). Scope is **service-account JSON keys** only. Others are
  Future work.
- **A BigQuery MCP server.** Considered and deferred; the ask is the `bq` CLI.

## Design

### 1. New credential delivery: `exposeAs: file`

A new delivery mode: write a single secret value to a 0600 file, then tell the
subprocess where the file is via an env var. `bq`/gcloud don't take a key path
as an argument — they *discover* the key by reading `GOOGLE_APPLICATION_CREDENTIALS`
from the environment. So `exposeAs: file` = "materialize the secret to a file,
set the tool's discovery env var to that path." The value never enters the env;
only the generated path does.

**Mental model.** Keep the two existing concepts unchanged and add only what's
needed for file delivery:

- `fields:` = the secret value(s) stored, exactly as today.
- `exposeAs:` = how they reach the subprocess. For `file`, the **entire file is
  the secret, verbatim** — so a `file` credential has **exactly one field** and
  its value is written to the file as-is. No JSON assembly, no templating.
- `pathEnv:` = the env var to set to the generated file's path (the tool's
  discovery variable). This replaces the earlier `file:` block — that block read
  like a filename and split delivery config across two places.

Config shape (`src/config.ts`):

```yaml
userCredentials:
  bigquery:
    label: "BigQuery"
    exposeAs: file
    pathEnv: GOOGLE_APPLICATION_CREDENTIALS   # env var set to the file's path
    fields:
      key:                                    # single field; its value IS the file, verbatim
        label: "Service account key (JSON)"
        type: json                            # form-only: textarea + validate (see §6)
        defaultFromEnv: SHARED_BIGQUERY_SA_KEY
    guidance: "Paste a service-account JSON key with the BigQuery roles you need."
    sharedAccessNote: "read-only (BigQuery Data Viewer + Job User) — INSERT/UPDATE/DELETE/DDL and cross-project writes will fail"
```

The on-disk filename is **derived** (e.g. `<handle>-<credName>`, see §3) — not a
config knob.

Validation additions in `src/config.ts` (mirrors the existing `exposeAs` guard
that currently rejects anything other than `env`/`git-credential-helper`):

- Allow `exposeAs: file`.
- A `file` credential must have **exactly one field** and a `pathEnv`.
- `pathEnv` must be one of an allowlisted set (at minimum
  `GOOGLE_APPLICATION_CREDENTIALS`) — never `PATH`/`HOME`/`LD_*` etc. Reject
  otherwise so config can't smuggle an arbitrary env override through this path.

### 2. Credential resolution (`src/credentials.ts`)

Add a third branch to `resolveUserCredentials` alongside `git-credential-helper`
and plain env. Extend `ResolvedCredentials` with (also add `files: []` to the
`EMPTY` constant and the in-function `result` initializer in
`src/credentials.ts`):

```ts
/** File credentials to materialize at spawn (path env injected, value never in env). */
files: Array<{
  pathEnv: string;    // env var to set to the file path (e.g. GOOGLE_APPLICATION_CREDENTIALS)
  credName: string;   // used to derive the on-disk filename
  value: string;      // raw file content, written verbatim (JSON for BigQuery)
  source: 'user' | 'shared';
  cacheKey: string;   // `${userId}|${credName}` or `shared|${credName}`
}>;
```

- Resolution precedence identical to the others: personal secret first, then
  `defaultFromEnv`, else skip.
- Push `value` into `result.secretValues` for scrubbing.
- Add the cred name to `personalCredNames` / `sharedCredNames` for audit.
- Feed `value` into the identity `hashInput` (name-scoped) so a key change
  respawns the persistent process.
- Add a `resolveSharedFileCredential(config)` analogous to
  `resolveSharedGitCredential` **only if** startup needs it — BigQuery does not
  run at startup, so this is likely unnecessary. (Noted so we don't add it
  reflexively.)

### 3. File materialization at spawn

New `src/file-credentials.ts`. Rather than copying `src/git-credentials.ts`
wholesale, extract the shared primitive — "materialize a secret to a 0600 file
under `.secrets/<subdir>/`, handle = `sha256(cacheKey\nvalue)`, reuse-if-exists,
single-quote guard, wipe-dir cleanup" — into a helper both modules use, so there
aren't two near-identical modules and two divergent cleanup implementations:

- `fileCredentialsDir(baseDir?)` → `.secrets/file-credentials/`.
- `ensureFileCredential({cacheKey, value, credName})` → writes
  `<handle>-<credName>` at mode `0600` (handle = `sha256(cacheKey \n value)`,
  reused across spawns for the same identity+value; rotates when the value
  changes), returns the absolute path. The filename is derived, not configured.
- `cleanupFileCredentialFiles(baseDir?)` → wipe the dir; call from
  `src/index.ts` startup **right next to** the existing
  `cleanupGitCredentialFiles()` (before `syncRepos()`), same rationale.

Reuse the single-quote guard and 0600/chmod belt-and-suspenders from the git
module.

### 4. Spawn env injection (`src/claude-spawn-env.ts`)

Add `buildFileCredentialEnv(options)` mirroring `buildGitEnv`:

```ts
function buildFileCredentialEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const f of options.credentials?.files ?? []) {
    const path = ensureFileCredential(f);
    env[f.pathEnv] = path;          // e.g. GOOGLE_APPLICATION_CREDENTIALS
  }
  return env;
}
```

Call it from `buildPermissionsEnv` (same place `buildGitEnv` is applied) so the
path lands in `extraEnv`. Note `CLOUDSDK_CONFIG` is **not** in the baseline
allowlist in `buildAllowedEnv`, so if we redirect it, it must also flow through
`extraEnv` (injected-env layer), not rely on passthrough. The path is a generated, non-secret filesystem path,
so injecting it via `extraEnv` is correct; the **value** only ever exists in the
0600 file, never in the process env.

Optionally set `CLOUDSDK_CONFIG` to a per-session dir under the temp tree so
`bq`/`gcloud` scratch (`~/.config/gcloud`) stays inside the managed temp dir
instead of writing to `$HOME`. Decide during implementation.

### 5. Shared default format (`.env`)

`SHARED_BIGQUERY_SA_KEY` holds the **raw JSON** of the service-account key. The
JSON is single-line-safe (the `private_key` newlines are already `\n` escapes
inside the JSON string), so it can be stored single-quoted on one line in
`.env`. If quoting proves painful, support an optional base64 form: if the
resolved value isn't valid JSON, try base64-decoding before writing. Personal
values submitted through the form are always raw JSON (see §6). Recommendation:
**raw JSON**, with base64 auto-detect as a convenience.

### 6. `!creds` form: JSON field type (`src/adapters/creds/`)

`type` is a **form-rendering + validation** concern only — it has nothing to do
with `file` delivery. It controls how the field is captured and checked in the
enrollment form; the stored value is written to the file verbatim regardless.

The form currently renders single-line inputs. Add a field `type: json` that:

- Renders a `<textarea>` with the field's `guidance`.
- Validates on submit: parses JSON, requires `type === "service_account"` and
  the presence of `client_email` + `private_key`; rejects with a clear message
  otherwise (so a paste error doesn't get stored and fail opaquely at query
  time).
- Stores the raw JSON string in the encrypted store like any other field value.
- Renders the key in cleartext (a masked textarea isn't practical) — acceptable
  shoulder-surfing tradeoff, note it in the field guidance.

This is the form's **first** field-level validation (today `handlePost` stores
any non-empty trimmed string); build the validation hook so other field types
can reuse it later.

`!creds list` / `!creds revoke` and the per-field delete checkboxes are already
generic and need no change.

### 7. Secret store (`src/secrets.ts`)

No structural change — the SA JSON is just a (large) string field value,
AES-256-GCM at rest in `.secrets/user-credentials.json`. Verified: the store has
no field-length cap (values are encrypted whole), so a ~2.3 KB key is fine. Scrubbing already
collects resolved values into `secretValues`; the whole JSON string is scrubbed
verbatim from stderr/errors. Note: if a log ever contained only the
`private_key` substring (not the whole JSON), it wouldn't match — acceptable,
since we write the file ourselves and don't echo the value.

### 8. Dockerfile: install `bq`

Add the Google Cloud CLI to the image (`bq` + `gcloud`). It needs `python3`.
Prefer the apt repo with `--no-install-recommends` and only the core CLI to keep
the layer small:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      apt-transport-https ca-certificates gnupg python3 && \
    echo "deb https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    apt-get update && apt-get install -y --no-install-recommends google-cloud-cli && \
    rm -rf /var/lib/apt/lists/*
```

Trade-off: realistically ~500 MB–1 GB (SDK + python3 + deps — the base image has
neither python3 nor gnupg). Measure; if it's too heavy, the BigQuery MCP server
(via the already-present `uvx`) becomes the fallback (Future). Also required:
add `SHARED_BIGQUERY_SA_KEY` to the compose `environment:` list — the compose
env model is strictly enumerated, nothing passes through implicitly. Docker's
`.env` parser does not support multi-line values, so the key must stay
single-line (it is: `private_key` newlines are `\n`-escaped inside the JSON).

### 9. Process identity / respawn

Already handled: `secretsHash` (built from `hashInput`) is part of
`processIdentityKey`, so enrolling/rotating a BigQuery key mid-thread kills and
`--resume`s the persistent process with the new file. No new code — just ensure
§2 feeds the value into `hashInput`.

### 10. Audit

`spawn` and enrollment events already record credential **names** (never
values). The `bigquery` cred name flows through `personalCredNames` /
`sharedCredNames` into the existing audit records. No change.

## Config example (added to `config.example.yaml`, commented)

```yaml
#   bigquery:
#     label: "BigQuery"
#     exposeAs: file
#     pathEnv: GOOGLE_APPLICATION_CREDENTIALS
#     fields:
#       key:
#         label: "Service account key (JSON)"
#         type: json
#         defaultFromEnv: SHARED_BIGQUERY_SA_KEY
#     guidance: "Paste a service-account JSON key with the BigQuery roles you need."
#     sharedAccessNote: "read-only (Data Viewer + Job User) — writes/DDL will fail"
```

## Open decisions (resolve during build)

1. **Shared default encoding** — raw JSON (recommended) vs. base64 in `.env`.
   Support base64 auto-detect as fallback.
2. **`CLOUDSDK_CONFIG` redirect** into the session temp dir — nice hygiene;
   confirm `bq` honors it and it doesn't break ADC discovery.
3. **`pathEnv` allowlist** — start with just `GOOGLE_APPLICATION_CREDENTIALS`;
   widen only as new file creds appear.

## Build sequence

1. Config schema + validation for `exposeAs: file` (`src/config.ts`) + tests.
2. `src/file-credentials.ts` (materialize/cleanup) + tests (copy
   `git-credentials.test.ts` shape: 0600, reuse, rotate-on-change, cleanup).
3. Resolution branch + `ResolvedCredentials.files` (`src/credentials.ts`) +
   tests (personal > shared > unset; scrubbing; hash contribution).
4. Spawn env injection (`src/claude-spawn-env.ts`) + startup cleanup wiring
   (`src/index.ts`).
5. `!creds` form `type: json` field + validation (`src/adapters/creds/`) +
   tests.
6. Dockerfile `bq` install.
7. Docs + example config + `.env.example`.

## Testing

- Unit: config validation (accept `file`, reject bad `pathEnv`, require single
  field); resolution precedence + scrubbing + hash; file materialization
  (perms, reuse, rotation, cleanup); env injection sets the path and never the
  value; form JSON validation (valid SA, malformed JSON, wrong `type`).
- Manual/integration: enroll a personal SA via `!creds`, confirm a `bq query`
  runs under it; unenrolled user falls back to the read-only shared SA and a
  write query fails as described in `sharedAccessNote`; rotate a key mid-thread
  and confirm respawn.

## Docs to update

- `docs/per-user-credentials.md` — BigQuery section (enrollment, read-only
  shared default, roles needed).
- `docs/configuration.md` — `userCredentials` `exposeAs: file` + `pathEnv` +
  `type: json` field.
- `docs/deployment.md` — `SHARED_BIGQUERY_SA_KEY` setup, GCP SA creation with
  read-only roles (BigQuery Data Viewer + Job User), `bq` install note.
- `README.md` — env table row for `SHARED_BIGQUERY_SA_KEY`.
- `.env.example` — `SHARED_BIGQUERY_SA_KEY` placeholder.
- `config.example.yaml` — commented `bigquery` block above.
- `CHANGELOG.md` — entry on release.

## Security considerations

- **SA keys are long-lived, high-value secrets.** Per-user keys are encrypted at
  rest (existing store) and materialized to 0600 files wiped at startup — same
  posture as the git token. The shared SA should be **minimally scoped**
  (read-only roles, single project/datasets) since its key sits in `.env` and
  reaches every unenrolled user's subprocess.
- **No tool-layer write guard.** Unlike MCP `READ_ONLY_MODE`, we can't force
  `bq` read-only. Read-only is enforced by the shared SA's IAM roles;
  `sharedAccessNote` tells the agent to expect writes to fail and to point users
  at `!creds`. This mirrors the shared-GitHub-PAT model and is a guardrail, not
  a security boundary.
- **Prefer org-approved, key-less auth long term** (Workload Identity
  Federation) to avoid distributing SA keys at all — Future.

## Future

- User OAuth / ADC and Workload Identity Federation as non-key auth options.
- BigQuery MCP server as an alternative/adjunct to the CLI (structured tools,
  avoids the Cloud SDK install), reusing the same `file` credential for its SA.
- Reuse `exposeAs: file` for other file-based credentials whose whole content is
  the secret (kubeconfig with an embedded token, etc.).
- **Templated file credentials** — for files that are mostly boilerplate with a
  secret embedded (a `.pgpass` line, a kubeconfig where only a token is secret),
  add an optional file template with `${FIELD}` placeholders filled from multiple
  `fields`. Not needed for BigQuery (its file is 100% secret, written verbatim);
  this is the generalization of the single-field-verbatim model to partial-secret
  files.
