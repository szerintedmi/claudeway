# Remote-Control Execution Mode

> **Update 2026-07-15:** `runClaude` and `runClaudeProcess` (the oneshot `--output-format json` runner) were removed on 2026-07-15 — batch mode now goes through `runClaudeStreaming` (`ClaudeResult` gained a lossless `fullText` field). Any dispatch integration described below in terms of `runClaude` should be reworked against `runClaudeStreaming` / `runClaudePersistentStreaming`.

## Context

Claudeway currently runs every Claude turn through `claude -p` (headless/print mode) — see `buildClaudeArgs()` (`src/claude.ts:823-866`) and the three runners `runClaude()` (`src/claude.ts:898`), `runClaudeStreaming()` (`src/claude.ts:940`), and `runClaudePersistentStreaming()` (`src/claude.ts:1262`). All emit/parse line-delimited `--output-format stream-json` (`parseStreamLine()`, `src/claude.ts:237-336`).

As of **Anthropic's 15 Jun 2026 billing change**, `claude -p` / Agent SDK / headless usage is metered against a **separate monthly credit pool billed at API rates**, *not* the Max subscription quota. Interactive Claude Code (the TUI, `claude` without `-p`) still draws on the subscription quota. The stated rule: *"if a human presses enter you stay on subscription; if a robot presses enter while you're away, it moves to metered credit."*

The reference project `munder-difflin` sidesteps the metered path by **never using `-p`**. It spawns the **interactive `claude` TUI inside a PTY** (`node-pty`), types `/remote-control` into it, then drives it by writing prompts into the PTY as bracketed-paste blocks (`src/renderer/src/hooks/useHive.ts:65-75`, `:162-172`, `:206-212`). Remote Control additionally lets the human approve native tool-permission prompts from a phone (`HIVE.md:46-52`).

**Goal:** Add an opt-in, per-channel/default config setting `executionMode: remote-control` that runs a channel's Claude turns through an **interactive PTY session with Remote Control enabled**, instead of `claude -p`. Two motivations, in priority order:

1. **Billing** — interactive sessions draw on the Max subscription quota rather than the metered `-p` credit pool. *(See the RED-flag caveat in "Risks" — this premise is unverified for programmatically-driven sessions and is gated by Phase 0.)*
2. **Native remote HITL** — tool-permission prompts surface in the live session and can be approved from the Claude mobile app / claude.ai, instead of Claudeway blanket-bypassing with `--dangerously-skip-permissions`.

`executionMode: print` (the current `claude -p` behavior) stays the default. No backward-incompatible changes.

### Verified facts that shape the design

(Confirmed against the locally-installed CLI `claude 2.1.153`, `claude --help`, `claude remote-control --help`, and `code.claude.com/docs`.)

- **Bun has a native PTY.** Bun 1.3.5+ exposes `Bun.spawn(cmd, { terminal: { cols, rows, name, data(chunk){} } })` with `proc.terminal.write()/resize()/setRawMode()/close()` (POSIX only). Claudeway runs **Bun 1.3.14** → we do **not** add `node-pty` (which is unreliable under Bun). *(Exact API surface to be confirmed in Phase 0 against 1.3.14 docs.)*
- **Startup flag exists.** `claude --remote-control [name]` enables Remote Control at launch — no need to type the `/remote-control` slash command into the PTY (cleaner than munder-difflin's approach). `claude remote-control` (subcommand) starts a standalone RC server.
- **All required flags are global** (work without `-p`): `--model`, `--session-id <uuid>`, `--resume <id>`, `--append-system-prompt`, `--mcp-config`, `--add-dir`, and `--permission-mode <default|acceptEdits|auto|dontAsk|plan|bypassPermissions>`.
- **Response capture is clean.** Interactive mode writes the same transcript JSONL Claudeway already locates via `sessionArtifactPaths(sessionId, cwd).jsonl`. `--session-id` controls the filename. The turn's reply is the last `{"type":"assistant"}` entry's `message.content[].text`. **No ANSI scraping of the PTY is needed for response content.**
- **Turn completion is signalable.** A `Stop` hook fires when the assistant finishes a turn; `Notification` fires on permission prompts. Hooks live in `.claude/settings.json` (project) or `~/.claude/settings.json` (global). *(Whether a per-session settings file can be injected at launch is a Phase 0 question — fallback is PTY-output idle detection, as munder-difflin does.)*
- **Auth.** Remote Control requires a **subscription OAuth login** (`claude auth login` / `CLAUDE_CODE_OAUTH_TOKEN`), **not** an API key. If `ANTHROPIC_API_KEY` reaches the subprocess it may route to API billing — it must be excluded from the env allowlist in this mode.
- **Workspace trust.** RC requires the working directory to be trusted (normally an interactive dialog). Claudeway clones/pulls repos fresh each startup, so trust must be pre-accepted non-interactively (Phase 0 spike).

---

## Design Principles

1. **Additive and opt-in.** New `executionMode` enum, default `print`. Channels not setting it behave exactly as today. The entire `-p` code path is untouched.

2. **Reuse everything above the spawn.** Session-ID derivation (`deriveSessionId`, `src/claude.ts:195`), env allowlist (`buildAllowedEnv`, `src/claude.ts:458`), system-prompt injection (`--append-system-prompt`), MCP read-only config (`src/mcp.ts`), permission/identity model, and per-channel serialization (`channelBusy`, `src/core/engine.ts`) all carry over unchanged. Only the **process spawning + I/O + completion detection** differ.

3. **Read the response from the transcript, not the terminal.** The PTY is used for *input* (typing the prompt) and a *completion signal*; the *answer* is read from the session JSONL. This avoids brittle TUI/ANSI parsing for content.

4. **Persistent by nature.** An RC session is a long-lived interactive process per channel. Mirror the existing `persistentRegistry` model (`src/claude.ts:1262-1299`): keep one PTY per channel+identity, respawn on identity change (`processIdentityKey`), and feed subsequent prompts into the live PTY for true multi-turn context.

5. **Batch responses first.** v1 returns the full turn after `Stop`. Token-by-token streaming back to Slack/voice is out of scope for v1 (TUI does not emit clean deltas); document the limitation. RC channels effectively run as `responseMode: batch` regardless of configured response mode.

6. **HITL is a config choice.** `permissionMode` selects autonomy vs. remote approval: `bypassPermissions` = fully autonomous (today's behavior), `default` = tool prompts block the turn until approved (from phone via RC). This is a feature, not a bug — but it means a blocked turn holds the channel until answered.

7. **Premise must be proven before reliance.** Phase 0 empirically verifies the billing benefit. If interactive-via-PTU is metered like `-p`, the billing motivation collapses (remote-HITL still stands) and we surface that explicitly rather than shipping a false promise.

---

## Config Shape

```yaml
defaults:
  model: opus
  responseMode: batch
  processMode: oneshot
  executionMode: print          # NEW: 'print' (default, claude -p) | 'remote-control'

channels:
  C0123456789:
    name: my-project
    repo: my-project
    executionMode: remote-control   # NEW: per-channel override
    # remoteControl-specific options (only read when executionMode: remote-control):
    remoteControl:
      permissionMode: bypassPermissions  # 'bypassPermissions' (autonomous) | 'default' (remote-approve prompts)
      sessionName: claudeway-myproject   # optional label shown in claude.ai RC session list
      bootTimeoutMs: 8000                # how long to wait for TUI ready before first prompt
      turnTimeoutMs: 600000              # max wait for a Stop signal before giving up
```

**Resolution:** `executionMode = ch.executionMode ?? defaults.executionMode ?? 'print'`, applied in `resolvedChannelConfig()` (`src/config.ts:312-331`), exactly like `processMode`. `remoteControl` block resolves with its own defaults; ignored when `executionMode !== 'remote-control'`.

---

## Architecture

```
Slack/Voice msg ──> engine.processQueuedMessage (unchanged)
                      │  resolves executionMode
                      ├── 'print'          ──> runClaude* (existing, claude -p)   [UNCHANGED]
                      └── 'remote-control'  ──> runClaudeRemoteControl (NEW)
                                                  │
                                                  ├─ get-or-spawn PTY session for (channel, identity)
                                                  │     Bun.spawn(['claude', ...rcArgs], { terminal })
                                                  │     args: --remote-control <name> --session-id <id>
                                                  │           --model --append-system-prompt --mcp-config
                                                  │           --permission-mode <mode> --add-dir
                                                  │     env: buildAllowedEnv() minus ANTHROPIC_API_KEY
                                                  │
                                                  ├─ wait for TUI ready (boot grace / readiness probe)
                                                  ├─ write prompt: ESC[200~<msg>ESC[201~  …140ms…  CR
                                                  ├─ await turn completion (Stop hook sentinel | idle)
                                                  └─ read last `assistant` entry from session JSONL
                                                        return ClaudeResult { response, usage, ... }
```

A new module `src/claude-remote-control.ts` (keeps `src/claude.ts` from ballooning) owns the PTY session registry and the runner. `src/claude.ts` exports stay the same; `runClaude*` gain a dispatch at the top *(`runClaude` removed 2026-07-15 — apply the same dispatch to `runClaudeStreaming` instead)*:

```typescript
export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  if (options.executionMode === 'remote-control') return runClaudeRemoteControl(options);
  /* ...existing print-mode body... */
}
```

`runClaudeStreaming` / `runClaudePersistentStreaming` dispatch the same way; in RC mode the streaming variants resolve to a single `onTextDelta(fullText)` emit after completion (batch-equivalent), so the engine's existing branch logic (`src/core/engine.ts:140-188`) needs no change beyond passing `executionMode` into the options.

### PTY session registry (`src/claude-remote-control.ts`)

Mirror `persistentRegistry` (`src/claude.ts:1262-1299`):

```typescript
interface RcSession {
  proc: Bun.Subprocess;          // has .terminal
  sessionId: string;
  identityKey: string;           // from processIdentityKey()
  ready: Promise<void>;          // resolves when TUI is accepting input
  outBuf: string;                // rolling PTY output (idle detection + readiness)
  currentTurn?: { resolve: (r: ClaudeResult) => void; reject: (e: Error) => void };
}
const rcRegistry = new Map<string, RcSession>();  // key: `${channelId}:${folder}`
```

- **Spawn:** build args (below), `Bun.spawn(['claude', ...args], { terminal: { cols: 120, rows: 40, name: 'xterm-256color', data: onPtyData } })`. `onPtyData` strips ANSI for *readiness/idle detection only* and appends to `outBuf`.
- **Identity change:** if an existing session's `identityKey !== processIdentityKey(...)`, kill + respawn (reuse the existing kill/wait pattern). Same trigger as persistent mode.
- **Reuse:** otherwise write the new prompt into the live PTY → true multi-turn session.

### Argument builder

```
claude
  --remote-control <sessionName>          # enable RC at launch
  --session-id <deriveSessionId(...)>     # deterministic; controls transcript filename
  --model <model>
  [--append-system-prompt <prompt>]       # same prompt as print mode (access restrictions)
  [--mcp-config <mcpConfigPath>]          # same read-only/full MCP gating
  --permission-mode <permissionMode>      # bypassPermissions | default
  --add-dir <tempDir/scratchDir as today>
```

Notably **no `-p`, no `--output-format`, no `--dangerously-skip-permissions`** (replaced by `--permission-mode`).

### Prompt injection into the PTY

Port munder-difflin's `submitToPty` (`useHive.ts:65-75`): write `\x1b[200~` + message + `\x1b[201~`, wait ~140 ms, write `\r`, then settle. Serialize writes per session (a promise chain) so concurrent turns can't jam the input line. The engine already serializes one message per channel (`channelBusy`), so cross-turn jamming is mostly prevented upstream; the per-PTY chain is defense-in-depth.

### Turn-completion detection (primary + fallback)

- **Primary — `Stop` hook sentinel.** Configure a `Stop` hook that writes/touches a per-session sentinel (e.g. `${tempDir}/.rc-turn-done`) or appends a unique marker. The runner resolves the turn when the sentinel for the in-flight turn appears. Hook-injection mechanism is a Phase 0 decision: (a) project `.claude/settings.json` written into the synced repo working dir, (b) a dedicated settings file via a launch flag if supported, or (c) scoped global settings. Avoid polluting the user's tracked repo files — prefer (a) in a gitignored path or (b).
- **Fallback — idle detection.** If hooks can't be scoped per-session, detect quiescence: PTY `data` silent for N ms *and* the TUI shows the idle input prompt (regex on ANSI-stripped `outBuf`), as munder-difflin does. Less precise; acceptable v1 fallback.
- On completion, read `sessionArtifactPaths(sessionId, cwd).jsonl`, take the last `{"type":"assistant"}` line, concatenate text content blocks → `ClaudeResult.response`. Pull `usage`/cost from the same entry if present.

---

## Implementation Steps

### Step 1: Config types & resolution (`src/config.ts`)
- Add `export type ExecutionMode = 'print' | 'remote-control';` near `ProcessMode` (line 9).
- Add `RemoteControlConfig { permissionMode?: 'bypassPermissions' | 'default'; sessionName?: string; bootTimeoutMs?: number; turnTimeoutMs?: number }`.
- Add `executionMode?: ExecutionMode` and `remoteControl?: RemoteControlConfig` to `ChannelConfig` (`:92-104`) and `Defaults` (`:106-116`).
- Add `executionMode: ExecutionMode` (always resolved) to `ResolvedChannelConfig` (`:301-310`) and resolve in `resolvedChannelConfig()` (`:312-331`): `ch.executionMode ?? config.defaults.executionMode ?? 'print'`; resolve `remoteControl` with defaults (`permissionMode: 'bypassPermissions'`, `bootTimeoutMs: 8000`, `turnTimeoutMs: 600000`).
- Validation in `loadConfig()`: reject unknown `executionMode`; warn if `executionMode: remote-control` and `responseMode` is a streaming mode (will be coerced to batch); warn if `ANTHROPIC_API_KEY` is in `env`/permission env while any channel uses RC.

### Step 2: New runner module (`src/claude-remote-control.ts`)
- `rcRegistry`, `RcSession`, `getOrSpawnRcSession()`, `runClaudeRemoteControl(options)`.
- `buildRemoteControlArgs(options, sessionId)` per the arg builder above.
- PTY spawn via `Bun.spawn({ terminal })`; readiness probe; `submitPrompt()` (bracketed paste); `awaitTurnCompletion()` (sentinel/idle); `readAssistantReplyFromTranscript(sessionId, cwd)`.
- Reuse `buildAllowedEnv` from `src/claude.ts` (export it if not already), then **delete `ANTHROPIC_API_KEY`** from the returned env for RC.

### Step 3: Dispatch from existing runners (`src/claude.ts`)
- Top-of-function dispatch in `runClaude`, `runClaudeStreaming`, `runClaudePersistentStreaming` → `runClaudeRemoteControl` when `options.executionMode === 'remote-control'`. *(`runClaude` removed 2026-07-15 — only the two streaming runners need the dispatch.)*
- Add `executionMode?: ExecutionMode` and `remoteControl?: ResolvedRemoteControlConfig` to `ClaudeOptions` (`:16-34`).
- Export `buildAllowedEnv` / `deriveSessionId` / `sessionArtifactPaths` / `processIdentityKey` if needed by the new module.

### Step 4: Thread through the engine (`src/core/engine.ts`)
- Pass `effectiveConfig.executionMode` and `effectiveConfig.remoteControl` into `claudeOpts` / `claudeStreamOpts` (`:140-188`). No branching change needed — RC handles batch internally and emits a single delta in the streaming branch.

### Step 5: Hook / settings plumbing (depends on Phase 0 outcome)
- If using a `Stop` hook: generate the hook settings (writing the sentinel) and wire it via the chosen mechanism. Keep it scoped to RC sessions only.
- If idle-detection only: implement the quiescence + idle-prompt detector; no settings changes.

### Step 6: Lifecycle integration (`src/index.ts`)
- On shutdown, tear down all `rcRegistry` PTYs (`proc.terminal.close()` / kill) alongside the existing persistent-process cleanup.
- Ensure pidfile/lifecycle logic accounts for long-lived RC children.

### Step 7: Config files & docs
- `config.example.yaml`: document `executionMode` + the `remoteControl` block with comments (billing caveat, batch-only, OAuth-not-API-key).
- `README.md`: new "Execution Modes" section — when to use `remote-control`, prerequisites (`claude auth login`, workspace trust, subscription), HITL behavior, the billing caveat.
- `CLAUDE.md`: add to Architecture (new `src/claude-remote-control.ts`) and Key Patterns (executionMode resolution; RC session registry mirrors persistent mode).

### Step 8: Tests
- `config.test.ts`: `executionMode`/`remoteControl` resolution + validation (unknown mode rejected, streaming→batch warning).
- New `claude-remote-control.test.ts`: `buildRemoteControlArgs` shape; transcript-parse extracts last assistant message; env allowlist drops `ANTHROPIC_API_KEY`; identity-change respawn keying. Mock `Bun.spawn`/PTY and a fixture JSONL — do **not** spawn a real `claude` in unit tests.
- Engine test: `executionMode` flows into claude options.

---

## Phase 0 — Validation Spikes (GATES the rest)

Do these *before* building Steps 1–8; they can each invalidate or reshape the plan.

1. **Billing (RED flag, highest priority).** Manually run a real interactive `claude --remote-control` session in a throwaway dir, drive a few turns by typing into a Bun-spawned PTY (no human), then check `/cost`, the claude.ai usage dashboard, and the metered-credit balance over a day. **Confirm turns draw subscription quota, not the metered `-p` pool.** Anthropic has *not* documented this for programmatically-driven sessions; if it meters like `-p`, the billing motivation is void — record the finding and decide whether remote-HITL alone justifies the feature. Consider asking Anthropic via `/feedback`/support.
2. **Bun PTY API.** Confirm the exact `Bun.spawn({ terminal })` surface on Bun 1.3.14 (`data` callback, `proc.terminal.write/close`, raw mode). Write a 30-line spike that spawns `claude --help` in a PTY and captures output.
3. **Workspace trust non-interactively.** Determine how to pre-accept trust for freshly-cloned repo dirs (settings key, `--permission-mode bypassPermissions` side effect, or env) so RC launches without a blocking trust dialog.
4. **Turn-completion mechanism.** Decide `Stop`-hook-sentinel vs idle-detection: can a hook be scoped per-session without polluting the user's repo or global config? Test whether `--remote-control` sessions fire `Stop` hooks as expected.
5. **Concurrency.** Confirm multiple concurrent RC sessions (one per channel/dir) are supported simultaneously and each gets an independent claude.ai session/URL.
6. **Readiness probe.** Find a reliable signal that the TUI is ready for input (vs a fixed `bootTimeoutMs` guess), to avoid dropping the first prompt.

---

## Risks & Open Questions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Billing premise unverified** — programmatic interactive sessions may still be metered like `-p`. | **RED / blocking** | Phase 0.1 empirical test before any reliance; document outcome; feature still offers remote-HITL even if metered. |
| 2 | Driving a TUI via PTY is inherently more fragile than stdin JSON (boot timing, paste jamming, prompt dropping). | High | Bracketed-paste + settle delays (munder-difflin pattern); readiness probe; per-PTY write serialization; `turnTimeoutMs` guard. |
| 3 | Workspace trust dialog blocks non-interactive launch. | High | Phase 0.3. |
| 4 | No clean token-streaming → RC channels are batch-only. | Medium | Documented constraint; coerce `responseMode` to batch with a warning. |
| 5 | `Stop`-hook scoping may require touching repo or global settings. | Medium | Idle-detection fallback (Phase 0.4). |
| 6 | OAuth-vs-API-key auth confusion; stray `ANTHROPIC_API_KEY` could route to API billing. | Medium | Drop `ANTHROPIC_API_KEY` from RC env allowlist; validate at config load. |
| 7 | Remote-HITL with `permissionMode: default` blocks the channel until a human approves on their phone. | Medium (by design) | Make it an explicit config choice; default `bypassPermissions`; document the blocking behavior. |
| 8 | Docker: PTY + outbound RC relay + OAuth + trust inside a container. | Medium | Validate in Phase 0; Bun native PTY is POSIX-OK in Linux containers. |
| 9 | A long-lived RC session is also reachable from the owner's phone — must respect Claudeway's read-only/multi-user model. | Low | System-prompt injection + MCP read-only + env allowlist still apply; `permissionMode` adds a layer. RC exposure is owner-scoped (single-dev tool). |

---

## Files to Modify

| File | Scope |
|------|-------|
| `src/config.ts` | `ExecutionMode`/`RemoteControlConfig` types; add to `ChannelConfig`/`Defaults`/`ResolvedChannelConfig`; resolve + validate |
| `src/claude-remote-control.ts` | **NEW** — RC session registry, PTY spawn/drive, transcript read, runner |
| `src/claude.ts` | Dispatch in `runClaude*` (`runClaude` removed 2026-07-15 — streaming runners only); add `executionMode`/`remoteControl` to `ClaudeOptions`; export `buildAllowedEnv`/`deriveSessionId`/`sessionArtifactPaths`/`processIdentityKey` |
| `src/core/engine.ts` | Thread `executionMode`/`remoteControl` into claude options |
| `src/index.ts` | Tear down RC PTYs on shutdown |
| `config.example.yaml` | Document `executionMode` + `remoteControl` block |
| `README.md` | "Execution Modes" section incl. billing caveat + prerequisites |
| `CLAUDE.md` | Architecture + Key Patterns updates |
| `src/__tests__/config.test.ts` | Resolution + validation tests |
| `src/__tests__/claude-remote-control.test.ts` | **NEW** — arg builder, transcript parse, env, registry keying (mocked PTY) |
| `src/__tests__/engine.test.ts` | `executionMode` flows into options |

**Not changed:** `src/queue.ts`, `src/tempdir.ts`, `src/sync-repos.ts`, `src/prompt.ts`, `src/mcp.ts`, `src/adapters/*` — RC reuses their output unchanged.

---

## Verification

1. **Type/lint/test:** `make server-typecheck && make server-test && make server-lint`.
2. **Default unchanged:** a channel without `executionMode` still runs `claude -p` (regression check on existing tests).
3. **Phase 0.1 billing** (the decisive one): with one channel on `remote-control`, send several Slack messages, then confirm via `/cost` + usage dashboard that they hit subscription quota, **not** metered credit.
4. **Multi-turn context:** two messages in a row to an RC channel share session context (second answer references the first) — confirms PTY reuse, not respawn.
5. **Identity respawn:** switch the sending user's permission set; confirm the RC PTY respawns (log line), mirroring persistent mode.
6. **Response fidelity:** RC reply delivered to Slack matches the last assistant message in the session JSONL.
7. **HITL:** with `permissionMode: default`, trigger a tool-permission prompt; confirm it's approvable from the Claude mobile app and the turn then completes.
8. **Shutdown:** SIGTERM tears down all RC PTYs; no orphaned `claude` processes.
9. **Auth hygiene:** log RC subprocess env keys; confirm `ANTHROPIC_API_KEY` is absent and OAuth/subscription auth is used.
