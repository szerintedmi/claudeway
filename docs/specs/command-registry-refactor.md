# Refactor: Extract Magic Commands into a Command Registry

## Context

`handleMagicCommand` in `src/slack.ts` has a cyclomatic complexity of 72 (lizard) — the worst offender in the codebase. It's a 115-line if/else chain where every command follows an identical pattern: match text, check auth, deny or execute. The `!kill #channel` and `!nudge #channel` variants duplicate ~20 lines of channel-resolution logic. New commands will only make this worse.

**Goal:** Extract magic commands into a registry-based system in a new `src/commands.ts` file, making commands easy to add without growing `slack.ts`.

## Design

### New file: `src/commands.ts`

A flat command registry — no classes, no dynamic loading, just a typed array of command definitions and a single dispatcher function.

```ts
type CommandScope = 'global' | 'channel';

interface CommandDef {
  name: string;              // e.g. "kill" (without "!")
  scope: CommandScope;       // auth level for bare usage
  hasChannelArg?: boolean;   // supports "!cmd #channel" variant (elevates to 'global' scope)
  handler: (ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
  channelId: string;         // where the message was sent
  targetChannelId: string;   // resolved target (= channelId when no arg)
  threadTs: string;
  messageTs: string;
  userId: string;
  client: WebClient;
  config: Config;
}
```

**Registry:**
```ts
const commands: CommandDef[] = [
  { name: 'config',  scope: 'global',  handler: configHandler },
  { name: 'ps',      scope: 'channel', handler: psHandler },
  { name: 'kill',    scope: 'channel', hasChannelArg: true, handler: killHandler },
  { name: 'killall', scope: 'global',  handler: killAllHandler },
  { name: 'nudge',   scope: 'channel', hasChannelArg: true, handler: nudgeHandler },
];
```

**Dispatcher:** A single exported `handleMagicCommand(text, channelId, threadTs, messageTs, userId, client): Promise<boolean>` function that:
1. Strips `!`, splits into command name + optional channel arg
2. Looks up command in the registry by name
3. If `hasChannelArg` and arg is present → resolve channel ID (shared logic, one implementation), use `'global'` scope
4. Auth check via `isMagicCommandAllowed` → deny or call `handler(ctx)`
5. Returns `true` if matched, `false` otherwise

### What moves to `src/commands.ts`

| Function | Currently at | Notes |
|----------|-------------|-------|
| `handlePs` | `slack.ts:1032` | Becomes `psHandler`, takes `CommandContext` |
| `handleKill` | `slack.ts:1084` | Becomes `killHandler` |
| `handleKillAll` | `slack.ts:1122` | Becomes `killAllHandler` |
| `handleNudge` | `slack.ts:1146` | Becomes `nudgeHandler` |
| `handleConfig` | `slack.ts:1211` | Becomes `configHandler` |
| `formatTimeout` | `slack.ts:1182` | Helper used by `handleConfig` |
| `formatChannelConfig` | `slack.ts:1189` | Helper used by `handleConfig` |
| `formatDuration` | `slack.ts:1021` | Helper used by `handlePs` |
| `getChannelName` | `slack.ts:998` | Helper used by multiple handlers |
| `findChannelIdByName` | `slack.ts:1009` | Used by dispatcher for channel arg resolution |
| `isMagicCommandAllowed` | `slack.ts:116` | Auth check used by dispatcher |
| `denyMagicCommand` | `slack.ts:130` | Denial helper used by dispatcher |
| `handleMagicCommand` | `slack.ts:1236` | Replaced by the new dispatcher |

### What stays in `src/slack.ts`

- `isUserAllowed` (exported, used by both command auth and message handler auth)
- `safeReact` (used pervasively by streaming/processing pipeline — will be exported for use by commands.ts)
- All streaming, processing, queue, image, and formatting code — untouched
- `registerMessageHandler` calls the new `handleMagicCommand` from `commands.ts`

### Changes to `src/slack.ts`

1. Remove all functions listed in the "moves" table above
2. Export `safeReact` (currently private, needed by `denyMagicCommand` in commands.ts)
3. Import and call `handleMagicCommand` from `./commands.js`
4. `isUserAllowed` export stays as-is

### Changes to test files

- `src/__tests__/slack.test.ts` — tests for `formatDuration`, `formatTimeout`, `formatChannelConfig` will import from `../commands.js` instead
- Consider adding `src/__tests__/commands.test.ts` for dispatcher logic

## Implementation Steps

1. Create `src/commands.ts` with types, registry, and dispatcher
2. Move handler functions from `slack.ts` → `commands.ts`, adapting signatures to `CommandContext`
3. Move helpers (`formatDuration`, `formatTimeout`, `formatChannelConfig`, `getChannelName`, `findChannelIdByName`, `isMagicCommandAllowed`, `denyMagicCommand`)
4. Export `safeReact` from `slack.ts`
5. Update `slack.ts`: `import { handleMagicCommand } from './commands.js'`
6. Update test imports
7. Verify: `bun run typecheck && bun test && bun run lint`

## Explicitly out of scope

- No dynamic file-based plugin loading or directory scanning
- No command class hierarchy or abstract base classes
- No separate file per command (premature until 15+ commands)
- No runtime registration API — the array IS the registry
- No changes to command behavior or output — pure structural refactor

## Verification

1. `bun run typecheck` — no type errors
2. `bun test` — all existing tests pass
3. `bun run lint` — no lint errors
4. Manual: all magic commands (`!ps`, `!kill`, `!kill #channel`, `!killall`, `!nudge`, `!nudge #channel`, `!config`) behave identically
