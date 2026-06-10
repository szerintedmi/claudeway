# Per-Turn Model Override via `!model:<name>` (Slack)

## Context

The model claudeway uses is fixed per channel (`channel.model ?? defaults.model` in `resolvedChannelConfig()`). There's no way to say "use opus just for this message" when messaging the bot — whether via @-mention or in a direct-respond channel. This adds a per-turn override: prefix a Slack message with `!model:<name>` (e.g. `!model:opus refactor this`, `!model:claude-opus-4-8 deep review`) and that single message runs with that model; the next message reverts to the channel default.

Decisions:
- **Syntax:** `!model:<name>` prefix.
- **No model-name validation** — pass straight to `claude --model <name>`; if the CLI rejects it, the existing error path reports it in the Slack thread. This also allows full versioned model IDs. Only a token-shape regex guard (args go through `spawn()` arrays, so no shell risk).
- **Per-turn only** — no sticky state.
- **Slack only** — voice adapter unchanged (the new optional field is simply never set there).
- **No config additions** — zero config complexity.

## Design notes (verified against code)

- **No magic-command collision:** `handleMagicCommand`'s regex either fails to match multi-word `!model:opus ...` (it's `$`-anchored, max 2 tokens) or matches with unknown command name `model:opus` → returns `false` and falls through. Parse the override *after* the magic-command block, on `magicText` (mention already stripped).
- **Mention preservation:** `shouldRespond()` (src/prompt.ts) needs `<@bot>` in `msg.text` for mention-trigger channels, so strip only the `!model:<name>` token from `msg.text`, keeping the mention prefix.
- **Persistent mode:** model is a spawn-time arg, so include the effective model in `processIdentityKey()` — a model change reuses the existing kill + respawn-with-`--resume` flow (session continuity preserved; two respawns per override turn is the accepted cost). On invalid model, `proc.on('close')` already deletes the registry entry and rejects the turn → `responder.onError` → Slack; next message recovers fresh with the default model.
- **Queue persistence is free:** queue is JSON-on-disk, so `modelOverride` survives restarts unchanged.

## Changes

### 1. `src/queue.ts`
- Add `modelOverride?: string;` to `QueuedMessage` (interface at lines 4–16).
- Replace `updateQueuedText(channelId, ts, newText)` (line 64) with `updateQueuedMessage(channelId, ts, { text, modelOverride })` — same single read-modify-write, but updates text **and** sets/clears `modelOverride` atomically (`modelOverride: undefined` must delete the field, so an edit that removes the prefix clears the override).

### 2. `src/adapters/slack/handler.ts`
After the magic-command block (ends ~line 120), before attachment handling:

```ts
// First char must be alphanumeric so option-like values (e.g. `--verbose`) can't
// become CLI args; spawn() arrays already prevent shell injection.
const MODEL_OVERRIDE_RE = /^\s*!model:([A-Za-z0-9][\w.\-\[\]:]*)(?:\s+([\s\S]*))?$/;

export function parseModelOverride(text: string): { model: string; rest: string } | null {
  const m = text.match(MODEL_OVERRIDE_RE);
  if (!m) return null;
  return { model: m[1], rest: (m[2] ?? '').trim() };
}
```

Wiring:
```ts
let modelOverride: string | undefined;
const override = parseModelOverride(magicText);
if (override) {
  modelOverride = override.model;
  const mentionPrefix = msg.text?.match(new RegExp(`^\\s*<@${botUserId}>\\s*`))?.[0] ?? '';
  msg.text = mentionPrefix + override.rest; // strip token, keep mention for shouldRespond
}
```

- Empty body guard: if `override && override.rest === '' && !attachmentText && !hasFiles`, reply in-thread with usage hint (`Usage: \`!model:<name> <message>\``) and return. (Override + file attachment with no text stays valid — existing fallback text applies.)
- Add `modelOverride` to the `enqueue()` payload (~line 245).
- Malformed tokens (e.g. `!model:opus,`) don't match the regex → message passes through untouched as a normal prompt. Mid-message `!model:` never matches (anchored).
- **Edit path** (`message_changed` branch, ~lines 93–102): re-parse the edited text so edits can add, change, or remove the override. Strip the bot mention (same regex as line 106), run `parseModelOverride`, then call `updateQueuedMessage(channel, origTs, { text: mentionPrefix + (override?.rest ?? stripped), modelOverride: override?.model })` — editing `!model:opus foo` → `foo` must clear the stale Opus override.
- To keep mention handling testable, extract the parse + mention-preserving strip into a pure exported helper used by both the new-message and edit paths:
  ```ts
  export function applyModelOverride(text: string, botUserId: string):
    { text: string; modelOverride?: string }
  ```

### 3. `src/core/engine.ts`
In `processQueuedMessage`, change `model: channelConfig.model` → `model: queued.modelOverride ?? channelConfig.model` in **both** option objects (batch `claudeOpts` ~line 148 and streaming `claudeStreamOpts` ~line 179 — these feed all three runners through the same `ClaudeOptions.model`). Optionally append `` [model: ${queued.modelOverride}]`` to the existing "Processing" log line (~121).

### 4. `src/claude.ts`
- `processIdentityKey()` (line 513): add `model: string` param, append `|${model}` to the key. Update both call sites to pass `options.model`: `createPersistentProcess` (~1066) and `runClaudePersistentStreaming` (~1271).
- Error readability fix (small, recommended): persistent-mode close-rejection currently says only `Persistent Claude process exited with code ${code}` (stderr goes to console only). Add `stderrBuf` to `PersistentProcessEntry`: **append** chunks in the stderr handler with a bound (keep the last ~2KB, trimming from the front), and **reset to ''** when each new turn is written to stdin — so the close-rejection message carries the complete stderr of the current turn only, never a stale fragment from an earlier turn. Append it to the rejection message. (Batch/streaming already include stderr in rejections — no change needed.)

### 5. Tests (`src/__tests__/`, run via `make server-test`)
New `model-override.test.ts`:
- **Parsing**: `parseModelOverride` — simple alias, full id (`claude-opus-4-8`), bracketed (`claude-fable-5[1m]`), no body → `rest: ''`, mid-message → null, empty name (`!model: hi`) → null, trailing junk (`!model:opus, hi`) → null, option-like value (`!model:--verbose hi`) → null, multiline rest preserved.
- **Mention preservation**: `applyModelOverride('<@BOT> !model:opus do x', 'BOT')` → `{ text: '<@BOT> do x', modelOverride: 'opus' }`; without prefix → text unchanged, no override; without mention (direct-respond channel) works too.
- **Magic-command non-interception**: `handleMagicCommand('!model:opus', …)` and `('!model:opus do x', …)` return `false` with a stub client.
- **Queue**: enqueue → `getPending` round-trip preserves `modelOverride`; `updateQueuedMessage` sets a new override, and clears it when called with `modelOverride: undefined` (the field must be gone from the JSON on disk).
- **Engine wiring (critical — catches a forgotten branch)**: using Bun's `mock.module('../claude.js', …)` to stub `runClaude` / `runClaudeStreaming` and capture the `ClaudeOptions` they receive, run `processQueuedMessage` with a queued message carrying `modelOverride`:
  - batch mode (plain responder) → captured `options.model` === override;
  - streaming mode (streaming responder / `responseMode: streaming`) → captured `options.model` === override;
  - no override → captured `options.model` === channel config model (fallback intact).

Extend `env-allowlist.test.ts` (lines 176–215): update existing `processIdentityKey` calls to the 5-arg signature; add case — same inputs, different model → different keys; same model → equal keys.

### 6. Docs
- `README.md`: short subsection after the magic-command table (~lines 290–305) — it's not a magic command, it rides the normal queue. Mention: per-turn only, no validation (CLI errors reported in-thread), persistent sessions transparently respawn with `--resume`.
- `config.example.yaml`: one-line comment next to `model:` (~line 95) pointing at the per-message override.
- `CHANGELOG.md`: entry per repo convention.

## Verification

1. `make server-test && make server-typecheck && make server-lint`
2. Manual, oneshot channel:
   - `@bot !model:opus say hi` → responds; next plain message uses default model (check server log).
   - `@bot !model:garbage hi` → ❌ reaction + `:warning: Error: Claude exited with code 1: ...` in thread.
   - `@bot !model:opus` (no body) → usage hint reply.
   - `@bot tell me about !model:opus syntax` → treated as a normal prompt (no override).
   - Edit a still-queued `!model:opus foo` to `foo` → runs on the default model; edit `foo` to `!model:haiku foo` → runs on Haiku.
   - `!kill` / `!ps` / `!config` still work.
3. Manual, persistent channel: override message → log shows identity respawn; follow-up question referencing an earlier turn confirms `--resume` context retained; invalid model → readable error, next message recovers on default model.
