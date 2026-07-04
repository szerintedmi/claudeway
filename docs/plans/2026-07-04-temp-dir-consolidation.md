# Temp directory consolidation

Date: 2026-07-04
Status: Implemented

## Problem

Temp/working files for a conversation are scattered across **three stores in two
base directories**, with **two retention policies**, plus a fourth uncontrolled
location:

1. **Slack downloads (inbound)** — `.docker/files/<channelId>/<fileId>-<name>`
   (`FILE_TEMP_BASE`, `src/adapters/slack/files.ts`). Keyed by **channel**,
   written eagerly at enqueue time in the handler. Per-channel, not per-thread.
2. **Per-request outbox** — `.claudeway-tmp/req-XXXXXX/attachments.txt` + staged
   files (`createRequestTempDir`, `src/tempdir.ts`; drained/deleted in
   `src/core/engine.ts`). Ephemeral per turn. Reached by the subprocess via
   `CLAUDEWAY_TEMP_DIR` (oneshot) or `CLAUDEWAY_TEMP_BASE` + a
   `<channelId>.current` **pointer file** (persistent mode).
3. **Scratch** — `.claudeway-tmp/scratch/<channelId>/` (`ensureScratchDir`).
   Persistent per-**channel** workspace, `$CLAUDEWAY_SCRATCH_DIR`.
4. **`/tmp`** — anything Claude's tools create with `mktemp`, Python `tempfile`,
   `os.tmpdir()`, etc. `TMPDIR` is only passed through from the operator's env
   (baseline allowlist, `src/claude-spawn-env.ts`); unset → `/tmp`, entirely
   outside all of the above.

Consequences:

- Three cleanup passes, two retentions (`cleanupStaleTempFiles` 90d over files +
  req dirs + scratch; `cleanupStaleWorktrees` 14d), and `/tmp` never cleaned.
- Two env vars + a pointer-file mechanism just to tell the subprocess where to
  write, with different behaviour in oneshot vs persistent mode.
- Confusing "scratch" terminology that predates worktrees and per-user creds.
- Files a user attached earlier in a thread don't reliably survive to later
  turns (downloads are per-channel and swept independently); generated files
  live in a third place again.

## Goals

- **One temp directory per session**, holding everything: inbound downloads,
  Claude-generated files, generic tool temp, and the outbound attachment
  manifest.
- **Everything persists across turns** within the session; a single GC reclaims
  the whole tree. Claude can re-read both the files people sent it and the files
  it generated, in any later turn, by path (the path is already in its
  transcript).
- **One env var** (`CLAUDEWAY_TEMP_DIR`) for the session dir, with **`TMPDIR`**
  pointed at its `tmp/` subfolder (D8) so generic tools land inside the managed
  tree too. Retire `CLAUDEWAY_SCRATCH_DIR`, `CLAUDEWAY_TEMP_BASE`, and the
  `.current` pointer file.
- Works identically for **Slack and voice** (and any future channel), because it
  keys on the resolved session, not on anything Slack-specific.
- Behaviour-compatible config: same `tempDir` / `tempMaxAgeDays` knobs, no schema
  change required in real configs.

## Non-goals

- Changing where **repo file edits** go — those still happen in the per-thread
  worktree cwd (`src/worktrees.ts`), committed to the `wt/<channel>/<thread>`
  branch. The temp dir is for non-repo working files only.
- Moving the temp dir *inside* the worktree. It stays on a stable base (see
  decision D2).
- Merging worktree GC into temp GC (they manage different things — git branches
  with possibly-unmerged work vs. disposable files).

## Target layout

One directory per session, keyed by the **resolved Claude session id** under the
existing `tempDir` base, grouped by channel for debuggability:

```
<tempDir>/<sanitize(channelId)>/<sessionId>/   ← the session temp dir ($CLAUDEWAY_TEMP_DIR)
  incoming/                                     ← inbound downloads (Slack/voice); sender-controlled names
  tmp/                                          ← $TMPDIR: generic tool temp (mktemp, python tempfile, …)
  .attachments                                  ← outbound upload manifest (drained + cleared each turn)
  .last-used                                    ← touched every turn; GC reads THIS, not file mtimes
  <root>                                        ← Claude's workspace (files it generates)
```

- **`incoming/`** holds inbound files, which are named by the *sender* — a
  namespace Claude doesn't control — so a downloaded `report.pdf` and a
  Claude-generated `report.pdf` must not collide. (Slack downloads already carry a
  `<fileId>-` prefix; the subfolder additionally keeps them out of Claude's view
  of its own workspace.)
- **`tmp/`** is `$TMPDIR` (decision D8). Keeping generic tool temp in its own
  subfolder captures the `/tmp` leak *and* avoids cluttering the workspace root
  (and, on Docker, avoids piling random tool files directly into the shared mount
  root). It's still swept with the session.
- Everything Claude generates lives at the **root** (the old "scratch").
- **`.last-used`** is touched on every turn so age-based GC keeps sessions that are
  active even when a turn writes nothing under the dir (decision D7).

## Key design decisions

- **D1 — Key on the resolved Claude session id, not `(channelId, threadTs)`.**
  `deriveSessionId(channelId, folder, threadTs)` (`src/claude.ts:247`) includes
  the **logical folder**, so `(channelId, threadTs)` alone is *not* equivalent to
  the session: a channel `folder`/`repo` config change produces a new Claude
  transcript while the old `(channelId, threadTs)` pair would wrongly reuse the
  same temp bucket (files from a different conversation resurface, or the new
  transcript can't see files it "remembers"). Keying by the actual `sessionId`
  keeps the temp bucket 1:1 with the transcript — a folder change gives a fresh
  bucket, consistent with the fresh transcript. (In **persistent** mode this only
  holds if the running process is respawned on the session change — see D9.)
  - `deriveSessionId` needs only `channelId` + the **logical** folder
    (`channelConfig.folder`) + `threadTs` — *not* the worktree cwd — so it's
    computable both in the Slack handler (download time) and in the engine, which
    resolves it anyway via `resolveSessionState`. The handler computes the same
    id from channel config; the engine reuses `session.sessionId`.
  - Path is `<tempDir>/<sanitize(channelId)>/<sessionId>/`: `channelId` as a
    (sanitized) parent for human-readable grouping, the UUID `sessionId` as the
    leaf. Because the leaf is a UUID, the earlier "raw `threadTs` in a path"
    injection surface disappears; only `channelId` needs sanitizing as a path
    component (D6).

- **D2 — Live on a stable base, not inside the worktree.** Non-repo Slack/voice
  channels and worktree-creation failures have **no worktree**; they still need a
  temp dir. Keeping it under `tempDir` (not in the worktree) serves them
  uniformly and dodges the `git status --porcelain` gotcha (a temp folder inside
  the worktree reads as untracked → `hasUnsavedWork` sees every worktree as dirty
  → worktree GC keeps them forever).

- **D3 — Files persist; only the *upload intent* is per-turn.** `.attachments` is
  an outbox signal ("upload these paths to the thread at end of this turn"), not
  Claude's memory and not a file store. The engine drains it (uploads listed
  files) then **clears the manifest only** — the files stay on disk. Not clearing
  would re-upload every previously-staged file on every subsequent turn
  (duplicate attachments in the thread). Claude re-reads/re-sends any file later
  by path because the file persists and the path is in its transcript.

- **D4 — Persistent-mode simplification.** Persistent processes are keyed
  `channelId:threadTs` (`registryKey`, `src/claude.ts`), i.e. **per-thread**, and
  their cwd is the per-thread worktree. So the session temp dir and the
  `.attachments` path are **fixed for the whole life of the process** → set once
  in the spawn env, no dynamic lookup. This removes `CLAUDEWAY_TEMP_BASE` and the
  `<channelId>.current` pointer file entirely.

- **D5 — Single GC, separate retentions (decided).** One pass over
  `<tempDir>/<channelId>/<sessionId>/`, one retention `tempMaxAgeDays` (default
  **90**). Worktree GC (`cleanupStaleWorktrees`, **14d**) stays separate and is
  *not* aligned: temp is disposable, worktrees may hold unmerged/uncommitted
  work.

- **D6 — Path safety (from review).** The layout joins channel ids and
  sender-supplied filenames into filesystem paths. Reuse the existing
  `sanitize()` from `src/worktrees.ts` (collapses `..`, filters to
  `[A-Za-z0-9._-]`) for the `channelId` path component and for **downloaded
  filenames** (in addition to the `<fileId>-` prefix). Add a resolved-path
  `isInside(sessionDir, target)` check (also already in `worktrees.ts`) before
  writing any download, so a crafted name can't escape the session dir. `sessionId`
  is a UUID and needs no sanitizing.

- **D7 — Touch a `.last-used` marker every turn (from review).** The GC's
  newest-mtime rule would delete an **active** session if a run of turns is
  text-only (a turn may call `resolveSessionTempDir()` and write nothing under
  it), silently losing earlier files after `tempMaxAgeDays`. Mirror the worktree
  `MARKER_FILE` pattern: `resolveSessionTempDir()` touches `.last-used` on every
  call, and `cleanupStaleTempDirs` keys off that marker's mtime (falling back to
  dir mtime), excluding `.last-used`/`.attachments` from any "is this dir
  meaningfully used" check. Test explicitly with a text-only turn.

- **D8 — `$TMPDIR` → `<session>/tmp` (decided).** Point `TMPDIR` at a `tmp/`
  subfolder, not the session root: it captures the generic-tool `/tmp` leak
  without cluttering `CLAUDEWAY_TEMP_DIR`'s root (where Claude's own files live)
  and keeps the main workflow unchanged. See the Docker section for the tmpfs
  interaction this introduces.

- **D9 — Respawn the persistent process when the resolved session changes (from
  review).** Persistent processes are looked up by `registryKey =
  channelId:threadTs` and respawned only when `processIdentityKey` differs — and
  that key includes **neither** the logical folder, cwd, nor `sessionId`
  (`src/claude.ts:1042`). So a channel `folder`/`repo` config change keeps the
  same regKey *and* the same identity key: the live process keeps its old cwd,
  old `--resume` session, and old `CLAUDEWAY_TEMP_DIR`/`TMPDIR` env, even though
  the engine now computes a *new* `sessionId` and drains the new session's
  (empty) `.attachments` — **attachments would be silently lost** and D1's
  "fresh bucket on folder change" would be false. Fix: make the persistent
  respawn fire on a session change. `PersistentProcessEntry` already stores
  `sessionId`, so the cheapest correct fix is to compare `entry.sessionId` against
  the incoming resolved `sessionId` (alongside the existing identity-key check)
  and respawn on mismatch; equivalently, fold `sessionId` into
  `processIdentityKey`. This is a pre-existing latent gap that consolidating temp
  dirs by `sessionId` turns into a real bug, so it must ship with this change.

- **D10 — Download Slack files at processing time, not enqueue (from review).**
  The handler currently downloads eagerly at enqueue (`handler.ts:371`) and the
  session id it computes there can go stale: config is hot-reloaded again at
  processing time (`engine.ts`), so a `folder`/`repo` change while a message sits
  in the queue means the handler wrote downloads under the **old** session id
  while the engine resolves a **new** one — the files sit in a dir that only the
  prompt's absolute path references and that GC can now reap independently of the
  live transcript. Fix: **defer the download to processing time**, where the
  resolved session is known. The insertion point already exists — the Slack
  coordinator's `prepare(queued, session)` (`coordinator.ts:40`) runs at
  processing time with the resolved `session` and already reads the queued
  `slack.files` metadata and renders attachment paths inline. Move
  `downloadSlackFiles` into `prepare()`, writing into
  `resolveIncomingDir(baseDir, channelId, session.sessionId)`. The coordinator
  already holds the `WebClient` (`coordinator.ts:36`), so the download token is
  covered — but the current `prepare(queued, session): Promise<{ text }>` contract
  lacks two things D10 needs: an **input** for where to write and an **output**
  channel for download failures.
  - **Extend the `PromptCoordinator.prepare` contract**
    (`src/core/interfaces.ts:16`) to `prepare(queued, session, ctx: {
    sessionTempDir: string }): Promise<{ text: string; warnings?: string[] }>`:
    - `ctx.sessionTempDir` — resolved by the engine after `resolveSessionState`
      (so `prepare` writes downloads under the correct session's `incoming/`); the
      engine already owns `config`/`resolvedTempDir`.
    - `warnings` — returned to the engine, which calls `responder.warn(w)` for
      each (reusing today's handler copy: "Failed to download N of M file(s)…").
      Without this, failed/oversized downloads become fatal throws or silent
      prompt omissions.
  - The queue's `SlackFileMeta` must carry the download **reference**
    (`url_private_download`, or the file id to re-resolve) instead of a
    pre-downloaded `localPath`. Keep that URL **server-side in the queue file
    only** — never in the prompt or subprocess env (consistent with the
    slack-history rework's constraint).
  - Bonus: files for messages edited/deleted/killed off the queue before
    processing are no longer downloaded at all.
  - Fallback if deferring is judged too invasive: store the enqueue-time session
    id on the queue entry and have the engine, on mismatch, **rehome** (move) the
    current message's `incoming/` files into the resolved session dir. Weaker —
    still downloads eagerly and leaves an orphan old-session dir — so D10 prefers
    the deferral. Voice is unaffected either way (no downloads).

## Voice channel

Explicitly covered — the design is channel-agnostic because it keys on the
resolved session id, which voice already provides:

- Voice sets `threadTs = session.sessionId` (`src/adapters/voice/handler.ts`) and
  carries a `repo` field, so **voice sessions already get worktrees and temp
  dirs today**. Under this refactor they get a session temp dir at
  `<tempDir>/<voiceChannelId>/<sessionId>/` — same code path as Slack.
- **No inbound downloads**: voice is audio, so `incoming/` is simply empty for
  voice sessions. No special-casing.
- **`uploadFile` is degenerate for voice**: the voice responder just announces
  `[File: <name>]` as text/TTS (`src/adapters/voice/responder.ts:313`) — it can't
  deliver a binary. With a persistent temp dir the generated file now **survives
  on disk**, so it can be retrieved out-of-band (or by a future voice file
  channel) instead of being deleted immediately. The manifest drain still calls
  `responder.uploadFile(path)` per staged file; voice announces, Slack uploads.
  No behaviour regression; a mild improvement (file no longer vanishes).
- **Session churn**: each voice connection is a new `sessionId` → a new temp dir;
  many short-lived dirs accumulate under the voice channel id. The single
  `.last-used`-marker GC (D7) handles this the same as Slack threads.

## Docker

The container setup interacts with this in three ways that must be handled or the
"persists across turns" promise breaks or behaves differently than local:

- **Persistence mismatch (must fix).** `.docker/` is bind-mounted
  (`docker-compose.yml:62` → `./.docker:/app/.docker`), so today's Slack downloads
  under `.docker/files/` **persist across container recreation**. But
  `.claudeway-tmp` is only `mkdir`'d in the image (`Dockerfile:46`) and is **not
  mounted** — so scratch and req dirs are on the container's writable layer and
  are **wiped on recreation**. Consolidating everything under `tempDir`
  (`.claudeway-tmp`) would make the *downloads* stop persisting — a regression.
  Fix: either (a) add a bind mount `./.docker/claudeway-tmp:/app/.claudeway-tmp`
  (or a named volume) so the session temp base persists like `.docker`, or (b)
  relocate the default temp base under the already-mounted `.docker/`. **Prefer
  (a)** — keeps `tempDir` semantics, one-line compose change, and matches the
  current downloads-persist behaviour. Decide deliberately: do we *want* temp to
  survive restart? Given "everything persists across turns" and per-thread
  persistent processes that can outlive a restart, yes.
- **`$TMPDIR` leaves the tmpfs (note the trade-off).** `/tmp` is a **100 MB
  tmpfs** (`docker-compose.yml:70` → `/tmp:size=100M`). Redirecting Claude's
  `TMPDIR` to `<session>/tmp` on the bind mount means tool temp (a) is no longer
  bounded by that 100 MB in-memory cap — it goes to disk under the mount, (b)
  now persists with the session and is visible on the host, (c) is slower
  (disk/bind vs tmpfs). Generally fine and arguably better (no silent 100 MB
  ceiling on tool scratch), but call it out; if a cap is desired, size the temp
  volume or keep a tmpfs for `<session>/tmp`.
- **`claudeway-attach` (no change needed).** It's symlinked into PATH
  (`Dockerfile:36` → `/usr/local/bin/claudeway-attach`); only the script *body*
  changes. Redeploy rebuilds the image with the new script.
- **Dockerfile `mkdir` (`:46`)** — drop `.docker/files` (downloads move to
  `incoming/` under the temp base); keep `.claudeway-tmp`. `docker-entrypoint.sh`
  does no dir/perms work, so nothing there. `scripts/docker-build.sh` only builds
  the skills build-context (its own local `TMPDIR`) — unaffected.

## Detailed changes by file

**`src/tempdir.ts`** (rewrite around the new model)
- Add `resolveSessionTempDir(baseDir, channelId, sessionId)` → creates and returns
  `<baseDir>/<sanitize(channelId)>/<sessionId>/`, mkdir'ing `incoming/` and `tmp/`,
  and **touches `.last-used`** on every call (D7). Reuse `sanitize()`/`isInside()`
  from `src/worktrees.ts` (or lift them to a shared util) for path safety (D6).
- Add `resolveIncomingDir(...)` → `<sessionTempDir>/incoming/`; add
  `resolveToolTmpDir(...)` → `<sessionTempDir>/tmp/` (the `$TMPDIR` target, D8).
- Replace `readAttachmentManifest(requestDir)` with one reading
  `<sessionTempDir>/.attachments`.
- Add `drainAttachmentManifest(sessionTempDir)` → returns paths, then truncates/
  removes `.attachments` only (files untouched). Replaces `cleanupRequestTempDir`.
- Remove `ensureScratchDir`, `createRequestTempDir`, `cleanupRequestTempDir`.
- Replace `cleanupStaleTempFiles(...)` with `cleanupStaleTempDirs(maxAgeDays,
  baseDir)` — walk `<baseDir>/<channelId>/<sessionId>`, key off the `.last-used`
  marker mtime (fallback dir mtime), one retention. No `fileTempBase` arg.

**`src/adapters/slack/files.ts`**
- `downloadSlackFiles(files, token, channelId, sessionId)` writes into
  `resolveIncomingDir(baseDir, channelId, sessionId)` instead of
  `FILE_TEMP_BASE/<channelId>`. Remove `FILE_TEMP_BASE` export. Sanitize the
  downloaded filename and verify the resolved path is inside the session dir (D6).

**`src/core/interfaces.ts`** (D10 contract)
- Extend `PromptCoordinator.prepare` (line 16) to `prepare(queued, session, ctx: {
  sessionTempDir: string }): Promise<{ text: string; warnings?: string[] }>`.

**`src/adapters/slack/handler.ts` + `coordinator.ts` + `queue.ts`** (D10)
- **Stop downloading at enqueue** in the handler (line 371). Persist the download
  reference on the queued `SlackFileMeta` (`url_private_download` or file id)
  instead of `localPath`; keep the URL in the queue file only, never in prompt/env.
- **Download in `coordinator.prepare(queued, session, ctx)`** (`coordinator.ts:40`)
  — it already holds the `WebClient`/token (line 36) and reads `slack.files`. Call
  `downloadSlackFiles(files, token, channelId, session.sessionId)` writing under
  `ctx.sessionTempDir/incoming/`, embed the resulting paths in the rendered
  prompt as today, and return download failures/size-skips as `warnings`.

**`src/core/engine.ts`** (D10 wiring)
- Pass `{ sessionTempDir }` (already resolved) into `prepare` (line 257); after it
  returns, `for (const w of rendered.warnings ?? []) await responder.warn(w)`.
  Non-fatal — a failed download warns and the turn proceeds without that file.

**`src/core/engine.ts`**
- Replace `ensureScratchDir` (line 135) + `createRequestTempDir` (line 209) with a
  single `resolveSessionTempDir(baseDir, channelId, session.sessionId)`. This must
  run **after** `resolveSessionState` (line 246) so it uses the resolved
  `sessionId` — reorder so the temp dir is created there (still before the runners,
  which need the env). The pre-session `scratchDir` at line 135 goes away.
- Pass the one dir to the runners (drop `scratchDir` + per-request `tempDir`).
- End-of-turn: `drainAttachmentManifest(sessionTempDir)` → upload → clear
  manifest. Remove the `cleanupRequestTempDir` call. Files persist.

**Docker** (see the Docker section)
- `docker-compose.yml` — add a persistent mount for the temp base (`.claudeway-tmp`).
- `Dockerfile:46` — drop `.docker/files` from the runtime-dir `mkdir`.

**`src/claude-spawn-env.ts`**
- `buildInjectedEnv`: set `CLAUDEWAY_TEMP_DIR = <sessionTempDir>` and
  `TMPDIR = <sessionTempDir>/tmp` (D8). Keep `CLAUDEWAY_CHANNEL_ID`. Remove
  `CLAUDEWAY_SCRATCH_DIR`.
- `TMPDIR` stays in `BASELINE_ENV_VARS` (harmless; injected value overrides it via
  the `Object.assign` at step 4 of `buildAllowedEnv`).
- Confirm `resolveExposedEnvVarNames` / `processIdentityKey` still exclude these
  injected vars (they do) — so a per-thread `TMPDIR` won't trigger spurious
  persistent respawns.

**`src/claude.ts`**
- Persistent path: inject the same `CLAUDEWAY_TEMP_DIR` + `TMPDIR`; remove
  `CLAUDEWAY_TEMP_BASE` (`options.tempBaseDir`) and the pointer-file dependency.
- Update `ClaudeOptions` (`tempDir` → session temp dir; drop `tempBaseDir`,
  `scratchDir`).
- `runClaudePersistentStreaming` (line 1033): add a **session-change respawn**
  (D9) — after the existing `entry.identityKey !== incomingIdentityKey` check
  (line 1051), also respawn when `entry.sessionId !== <resolved sessionId>` (or
  fold `sessionId` into `processIdentityKey`). Reuse the same kill/clear-turn path.

**`scripts/claudeway-attach`**
- Simplify to: append `$1` (resolved absolute) to `$CLAUDEWAY_TEMP_DIR/.attachments`.
  Drop the `CLAUDEWAY_TEMP_BASE` + pointer-file branch entirely.

**`src/index.ts`**
- Replace `cleanupStaleTempFiles(tempMaxAgeDays, resolvedTempDir(config),
  FILE_TEMP_BASE)` (line 113) with `cleanupStaleTempDirs(tempMaxAgeDays,
  resolvedTempDir(config))`. Drop the `FILE_TEMP_BASE` import.
- No automatic legacy sweep (decided) — see Migration for the manual list.

**System prompt** (`src/prompt.ts` / `src/adapters/slack/prompt.ts`)
- Replace the `$CLAUDEWAY_SCRATCH_DIR` guidance with:
  "Your working files live in `$CLAUDEWAY_TEMP_DIR` and persist across this
  conversation. Files people send you are in `$CLAUDEWAY_TEMP_DIR/incoming`. To
  send a file back, put it anywhere under that dir and run `claudeway-attach
  <path>`."

## Config & docs updates

- **`config.example.yaml`** — reword the `tempDir` comment (currently "Temp
  directory for per-request file attachments") to describe the per-session dir;
  `tempMaxAgeDays` comment stays. No key changes.
- **Real configs** (`config.yaml`, `config copy*.yaml`) — **no change required**;
  `tempDir` / `tempMaxAgeDays` keep their meaning. (`config copy*.yaml` are local
  untracked artifacts — leave them.)
- **`docs/configuration.md:38`** — update the defaults line (temp dir now
  per-session; scratch no longer a separate concept).
- **`docs/specs/2026-03-10-user-roles-readonly.md`** — note the scratch dir was
  superseded by the unified `$CLAUDEWAY_TEMP_DIR` (historical spec; add a status
  note rather than rewrite).
- **`docs/troubleshooting.md`** — add the one-time manual legacy-cleanup list
  (see Migration).
- **`docs/deployment.md`** — document the new temp-base persistence mount for
  Docker deploys.
- **`docs/TODO.md`** — reconcile any temp/scratch item.
- **`CLAUDE.md:32`** — retitle `src/tempdir.ts` from "Temp and scratch directory
  management" to "Per-session temp directory management"; update the Key Patterns
  section if it mentions scratch.
- **`README.md`** — currently has no temp/scratch/attachment section. Add a short
  note under the file-attachment feature: attachments and generated files persist
  per thread and are cleaned up after `tempMaxAgeDays`.
- **`CHANGELOG.md`** — new entry describing the consolidation and the removed env
  vars / pointer-file.

## Migration / backward compatibility

- **Orphaned old dirs — manual cleanup (decided)**: after deploy the old stores
  are no longer written but the pre-existing dirs linger. No automatic sweep;
  document that the operator can delete these by hand once (paths relative to the
  server working dir / `/app` in Docker):
  - `.docker/files/` — entire tree (old Slack downloads)
  - `.claudeway-tmp/req-*` — old per-request outbox dirs
  - `.claudeway-tmp/*.current` — old persistent-mode pointer files
  - `.claudeway-tmp/scratch/` — old per-channel scratch
  New per-session dirs (`.claudeway-tmp/<channelId>/<sessionId>/`) coexist without
  conflict, so this is non-urgent. Put the list in `docs/troubleshooting.md`.
- **In-flight persistent processes across a deploy**: a process spawned with the
  old env keeps using its old scratch/req dirs until it respawns; `TMPDIR` isn't
  in the identity key, so no forced respawn. Acceptable — next natural respawn
  picks up the new layout. Note in the changelog.
- **`claudeway-attach` on disk**: the script is installed to a fixed path
  (`scripts/install.sh`); redeploy/reinstall updates it. The new script is
  backward compatible in that it still reads `$CLAUDEWAY_TEMP_DIR` (now a
  different dir), so an updated script + old server env would write the manifest
  into the (ephemeral) old dir — acceptable transient during a rolling deploy.

## Testing

- **`src/__tests__/tempdir-cleanup.test.ts`** — rewrite for
  `cleanupStaleTempDirs` over the per-session tree, keyed off the **`.last-used`
  marker mtime** (D7), one retention. No legacy-sweep test — legacy cleanup is
  manual (decided).
- **`src/__tests__/env-allowlist.test.ts`** — assert `CLAUDEWAY_TEMP_DIR` is the
  session dir and `TMPDIR` is **`<CLAUDEWAY_TEMP_DIR>/tmp`** (child, not equal, per
  D8); assert `CLAUDEWAY_SCRATCH_DIR` / `CLAUDEWAY_TEMP_BASE` are gone.
- **New**: manifest drain-and-clear (files persist, manifest empties; no
  re-upload on a second drain); download → `incoming/`; voice session temp dir
  resolves with empty `incoming/`.
- **Active-session GC (D7)**: a session with only **text-only** turns for longer
  than `tempMaxAgeDays` (its files untouched, but `.last-used` touched each turn)
  is **kept**; a genuinely idle session past the cutoff is reaped. This is the
  regression P1 guards against — test it explicitly.
- **Path safety (D6)**: a download whose name contains `../` or path separators
  is sanitized and lands inside the session dir (resolved-path check); a hostile
  `channelId` component can't escape the base.
- **Session-change respawn (D9)**: a persistent process whose channel `folder`
  changes mid-thread is respawned so its cwd/env/temp dir track the new
  `sessionId`; staged attachments are drained from the correct (new) session dir,
  not silently lost.
- **Processing-time download (D10)**: with a `folder` change applied while a
  message is queued, the download lands in the **resolved** session's `incoming/`
  (not the enqueue-time session), so the files aren't orphaned in a GC-eligible
  old-session dir. Also assert a failed/oversized download returns a `warning`
  that the engine forwards to `responder.warn` (not a throw, not a silent drop).
- **Manual/verify**: attach a file in a Slack thread, confirm upload; second turn
  confirms no duplicate re-upload; confirm a `mktemp` file from a Bash tool call
  lands under `<session>/tmp`, not `/tmp`; in Docker, confirm the file survives a
  container recreation (persistence mount).

## Resolved decisions

1. **Retention** — temp 90d (`tempMaxAgeDays`), worktrees 14d, **kept
   independent**. Temp is disposable; worktrees may hold unmerged work.
2. **`$TMPDIR` target** — `<session>/tmp` subfolder (D8), not the root.
3. **Legacy sweep** — **manual** follow-up (list in Migration), no auto-delete.
4. **Session key** — the resolved `sessionId`, not `(channelId, threadTs)` (D1),
   so the temp bucket tracks the Claude transcript across folder/repo changes.
5. **Docker persistence** — mount the temp base so it survives container
   recreation (matches today's downloads behaviour); `$TMPDIR` leaves the 100 MB
   tmpfs (trade-off noted).

## Rollout

1. `src/tempdir.ts` new API (`resolveSessionTempDir` + `.last-used` touch +
   `sanitize`/`isInside`) + `cleanupStaleTempDirs` (marker-based) (+ tests).
2. Move Slack download to processing time in `coordinator.prepare` (D10): extend
   the `PromptCoordinator.prepare` contract (`interfaces.ts`) to take `{
   sessionTempDir }` and return `{ text, warnings? }`; engine forwards warnings to
   `responder.warn`; `queue.ts` `SlackFileMeta` carries the ref not `localPath`;
   `files.ts` writes to `incoming/` keyed by resolved `sessionId`, sanitized;
   handler stops downloading at enqueue.
3. Engine single-dir wiring (after `resolveSessionState`) + manifest
   drain-and-clear.
4. Env consolidation (`claude-spawn-env.ts`, `claude.ts`, `$TMPDIR`→`tmp/`) +
   persistent session-change respawn (D9) + `claudeway-attach`.
5. `index.ts` GC swap.
6. Docker: temp-base persistence mount + `Dockerfile` mkdir cleanup.
7. System prompt copy + docs/README/CHANGELOG + config.example comment +
   troubleshooting legacy-cleanup list.
8. Verify (Slack attach round-trip, no dup re-upload, `<session>/tmp` capture,
   voice session dir, text-only-turn GC survival, persistent folder-change
   respawn drains the new session dir, queued-message folder-change download
   lands in the resolved session, Docker restart persistence).
