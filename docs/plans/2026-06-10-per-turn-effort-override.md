# Per-Turn Effort Override via `!effort:<level>` (Slack)

## Context

Claudeway already supports a per-channel thinking-effort setting (`effort` in config, resolved in `resolvedChannelConfig()` and passed to the Claude CLI as `--effort`). The recently merged `!model:<name>` feature (PR on `my-main`, see `docs/plans/2026-06-09-per-turn-model-override.md`) lets a single Slack message override the model for that one turn. This adds the symmetric capability for effort: prefix a message with `!effort:<level>` (e.g. `!effort:high refactor this`) and that single turn runs with that effort; the next message reverts to the channel default.

Most of the plumbing already exists — `ClaudeOptions.effort` is wired through all three runners (`--effort` in `buildClaudeArgs` and `buildPersistentClaudeArgs`), and the engine already passes `effort: effectiveConfig.effort`. This change adds the per-turn **parse → validate → queue field → override** path.

### Why hardcoded validation (not pass-through, not a dynamic probe)

Investigation of the installed CLI (`claude 2.1.170`):

- `claude --help` lists the effort set as **`low, medium, high, xhigh, max`** — one global set per CLI version, not per-model. (Our config's `EffortLevel` type is `low|medium|high|max`, **missing `xhigh`**. "ultracode" is a workflow keyword, not a CLI effort.)
- An **invalid** `--effort` value does **not** fail the CLI — it prints `Warning: Unknown --effort value '<x>' — ignoring it and using the default effort.` to stderr and **runs the turn at the default effort** (exit 0).

Because the CLI silently runs at default on a bad value (no failure to catch, warning buried in success-path stderr), a pure pass-through (`!model:` style) or a try-and-parse-the-error approach would silently downgrade with no thread feedback. So we **validate the override against a hardcoded set before running** and block + show the valid list on a miss. The set is small and stable; a runtime `claude --help` probe was considered and rejected as unnecessary complexity.

Decisions (confirmed with user):
- **Hardcoded valid set:** `low, medium, high, xhigh, max`, defined once in `src/config.ts` as the single source of truth for both the `EffortLevel` type and runtime validation.
- **Invalid value → block + hint:** if the override isn't in the set, **do not run** the turn; reply in-thread with the valid values. (Mirrors the empty-body usage-hint pattern.)
- **Combinable with `!model:` in any order** — `!model:opus !effort:high do x` and `!effort:high !model:opus do x` both set both overrides and run `do x`.
- **Case-insensitive** input, normalized to lowercase before validation/storage.
- **Per-turn only**, **Slack only**, **no config additions**.

## Design notes (verified against code)

- **No magic-command collision:** same as `!model:` — `handleMagicCommand`'s regex is `$`-anchored/max-2-tokens, so `!effort:high ...` falls through. Parse overrides after the magic-command block.
- **Mention preservation:** strip only the override tokens, keep the `<@bot>` prefix so `shouldRespond()` still matches in mention-trigger channels.
- **Persistent mode:** `--effort` is a spawn-time arg, so effort must join `model` in `processIdentityKey()` — an effort change reuses the kill + respawn-with-`--resume` flow. Two call sites: `claude.ts:1069` (`createPersistentProcess`) and `claude.ts:1280` (`runClaudePersistentStreaming`).
- **Refactor `applyModelOverride` → `applyOverrides`:** to support both prefixes in any order, replace the single-token `applyModelOverride` (handler.ts:81) with a loop-based `applyOverrides` returning `{ text, modelOverride?, effortOverride? }`. The pure `parseModelOverride` helper stays; add a sibling `parseEffortOverride` that captures a freeform token (membership validation is done in the handler against the hardcoded set, so a bad value can be reported rather than silently ignored).

## Changes

### 1. `src/config.ts` — single source of truth for the effort set
Replace the standalone `EffortLevel` type (line 90) with a runtime array + derived type, adding the missing `xhigh`:

```ts
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
```

(Widening the type is backward-compatible with existing `effort?: EffortLevel` fields and `effort: ch.effort ?? config.defaults.effort` resolution.)

### 2. `src/claude.ts` — persistent identity key
`processIdentityKey()` (line 515): add an `effort: string` param, append `|${effort}` to the key. Update **both** call sites (`claude.ts:1069`, `claude.ts:1280`) to pass `options.effort ?? ''`.

### 3. `src/queue.ts`
- Import `EffortLevel` from `./config.js`.
- Add `effortOverride?: EffortLevel;` to `QueuedMessage` (after `modelOverride`, ~line 17).
- Extend `updateQueuedMessage`'s `updates` param to `{ text: string; modelOverride?: string; effortOverride?: EffortLevel }`, applying the same delete-when-`undefined` semantics already used for `modelOverride`.

### 4. `src/adapters/slack/handler.ts`
Add alongside the model-override helpers (~line 66). The regex captures a freeform token (alphanumeric first char so it can't become a CLI flag); membership is validated separately so a bad value yields a hint instead of falling through silently:

```ts
import { EFFORT_LEVELS, type EffortLevel } from '../../config.js'; // add to existing config import

const EFFORT_OVERRIDE_RE = /^\s*!effort:([A-Za-z0-9][\w.\-]*)(?:\s+([\s\S]*))?$/;

export function parseEffortOverride(text: string): { effort: string; rest: string } | null {
  const m = text.match(EFFORT_OVERRIDE_RE);
  if (!m) return null;
  return { effort: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}
```

Replace `applyModelOverride` (lines 81-89) with an order-independent stripper:

```ts
export function applyOverrides(
  text: string,
  botUserId: string,
): { text: string; modelOverride?: string; effortOverride?: string } {
  const mentionPrefix = text.match(new RegExp(`^\\s*<@${botUserId}>\\s*`))?.[0] ?? '';
  let rest = text.slice(mentionPrefix.length);
  let modelOverride: string | undefined;
  let effortOverride: string | undefined;
  for (;;) {
    const m = parseModelOverride(rest);
    if (m && modelOverride === undefined) { modelOverride = m.model; rest = m.rest; continue; }
    const e = parseEffortOverride(rest);
    if (e && effortOverride === undefined) { effortOverride = e.effort; rest = e.rest; continue; }
    break;
  }
  return { text: mentionPrefix + rest, modelOverride, effortOverride };
}
```

Wiring (the new-message path ~line 152 and the `message_changed` edit path ~line 118 currently call `applyModelOverride` → switch both to `applyOverrides`):

- **New-message path:** capture `effortOverride` alongside `modelOverride`. If set and not in the hardcoded set, block before enqueue:
  ```ts
  if (effortOverride && !EFFORT_LEVELS.includes(effortOverride as EffortLevel)) {
    await warnInThread(client, msg.channel, msg.thread_ts ?? msg.ts,
      `Unknown effort '${effortOverride}'. Valid: ${EFFORT_LEVELS.join(', ')}.`);
    return;
  }
  ```
- **Edit path:** re-validate the edited effort the same way; on invalid, skip the queue update and warn. On valid/cleared, pass `effortOverride: applied.effortOverride` into `updateQueuedMessage`.
- **Empty-body guard** (~line 175): broaden from `modelOverride && ...` to `(modelOverride || effortOverride) && !hasFiles && !attachmentText`, rewording the hint to cover both, e.g. `` Usage: `!model:<name>` / `!effort:<level>` — add a prompt after the override(s). ``
- **`enqueue()` payload** (~line 295): add `...(effortOverride ? { effortOverride: effortOverride as EffortLevel } : {})`.

### 5. `src/core/engine.ts`
In `processQueuedMessage`, change `effort: effectiveConfig.effort` → `effort: queued.effortOverride ?? effectiveConfig.effort` in **both** option objects (batch `claudeOpts` line 150, streaming `claudeStreamOpts` line 181). Extend the existing `modelSuffix` log line (~line 121) to also surface effort when overridden, e.g. append `` [effort: ${queued.effortOverride}]``.

### 6. Tests (`src/__tests__/`, via `make server-test`)
- **`model-override.test.ts`** (extend to cover effort + combined; switch `applyModelOverride` import/tests → `applyOverrides`, model-only assertions unchanged):
  - `parseEffortOverride`: valid token, uppercase normalized (`!effort:HIGH` → `high`), no body → `rest: ''`, mid-message → null, option-like (`!effort:--x`) → null. (It does **not** reject unknown values — the handler's set check does.)
  - `applyOverrides` combined: `!model:opus !effort:high do x` and `!effort:high !model:opus do x` both → `{ text: 'do x', modelOverride: 'opus', effortOverride: 'high' }`; mention preserved in both orders; duplicate token applies only the first.
  - Validation/handler: an unknown effort (e.g. `turbo`) is blocked with a hint and not enqueued; `xhigh` (a level the old enum lacked) is accepted.
  - Magic-command non-interception: `handleMagicCommand('!effort:high', …)` / `('!effort:high do x', …)` return `false`.
  - Queue round-trip: enqueue preserves `effortOverride`; `updateQueuedMessage` sets and clears it (field gone from JSON when `undefined`).
  - Engine wiring (critical): queued `effortOverride` → batch and streaming captured `options.effort` === override; no override → channel/default effort.
- **`env-allowlist.test.ts`** (lines 176-229): update all `processIdentityKey(...)` calls to the new 6-arg signature (add an effort arg); add a case: different effort → different keys, same effort → equal keys.

### 7. Docs
- `README.md` (per-turn override subsection ~line 318): add `!effort:<level>`; note valid values (`low, medium, high, xhigh, max`), combinable with `!model:` in any order, per-turn only, and that an unrecognized value replies with the valid list instead of running.
- `config.example.yaml` (~line 95, next to `effort:`): mirror the `# per-message override` comment for effort.
- `CHANGELOG.md`: entry per repo convention (after the `!model:` entry). Note the `xhigh` addition to `EffortLevel`.

## Verification

1. `make server-test && make server-typecheck && make server-lint`
2. Manual, oneshot channel:
   - `@bot !effort:high say hi` → responds; server log shows `[effort: high]`; next plain message reverts to default.
   - `@bot !effort:xhigh do x` → runs at xhigh (confirms the added level).
   - `@bot !model:opus !effort:high do x` and `@bot !effort:high !model:opus do x` → both run `do x` with opus + high.
   - `@bot !effort:turbo hi` → in-thread reply `Unknown effort 'turbo'. Valid: low, medium, high, xhigh, max.`; turn does **not** run.
   - `@bot !effort:high` (no body) → usage hint reply.
   - Edit a still-queued `!effort:high foo` → `foo` → runs on default; edit `foo` → `!effort:low foo` → runs on low.
   - `!kill` / `!ps` / `!config` still work.
3. Manual, persistent channel: an effort-override message → log shows identity respawn; a follow-up referencing an earlier turn confirms `--resume` context retained.
