# Error Handling: User-Facing Feedback

## Problem

Errors in subsidiary operations (file uploads, file downloads, thread context, streaming updates) are logged to console but never communicated back to the Slack user. The user sees silence — no indication that something went wrong.

The main `processQueuedMessage` catch handler is the only path that posts errors to Slack. Everything else is console-only.

## Current State

### Has Slack feedback

- **Main processing errors** (`processQueuedMessage` catch) — posts `:warning: Error: ...` to thread, adds `:x:` reaction
- **Magic command authorization** (`commands.ts`) — posts denial message to thread via `denyMagicCommand`
- **Magic command results** (`commands.ts`) — all commands post results/errors directly to Slack

### Console-only (no Slack feedback)

| Component | File | Behavior |
|---|---|---|
| Config load failure (during processing) | `slack.ts` ~925 | Silently dequeues message, no feedback at all |
| Config load failure (during routing) | `slack.ts` ~992 | Silent return, message never enqueued |
| File attachment uploads | `tempdir.ts` ~52 | Per-file catch, logs error, continues |
| File downloads | `slack.ts` ~80 | Per-file catch, logs error, skips file |
| Streaming update failures | `slack.ts` ~264 | Catch in `flush()`, logs, continues |
| Native stream append | `slack.ts` ~415 | Promise `.catch()`, logs |
| Thread context fetch | `thread.ts` ~76 | Returns `[]` on error, logs |
| Queue drain errors | `slack.ts` ~1076 | `.catch()`, logs |
| Startup drain errors | `slack.ts` ~1100 | `.catch()`, logs |
| Config load in magic commands | `commands.ts` ~322 | Not wrapped in try-catch — potential unhandled throw |
| Notification failures | `index.ts` ~89 | `notifyOwner` catch, logs, non-blocking |

### Intentionally silent (acceptable)

| Component | Reason |
|---|---|
| Reactions (`safeReact`) | Non-critical UI hint |
| Temp dir cleanup / `cleanupOldTempFiles` | Best-effort filesystem cleanup |
| Message deletion during streaming | Best-effort, fallback exists |
| Tool status updates | Ephemeral progress indicators |
| Queue file parse errors (`queue.ts`) | Gracefully skips corrupted files |
| Pidfile release | Best-effort cleanup |
| Orphan process killing | Best-effort cleanup |

### Docker considerations

When running in Docker (`Dockerfile`, `docker-compose.yml`):

- **Console logs are the primary observability channel** — `console.error` output goes to `docker logs`. User-facing Slack warnings become even more important since operators may not be watching logs in real time.
- **Environment variable sanitization** — `claude.ts` strips `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` from child process env before spawning Claude CLI. Errors in this path (e.g., missing env vars at startup) would surface as Slack connection failures, not handled gracefully.
- **Volume mount failures** — If config.yaml, .claude, or project folders aren't mounted correctly, errors surface as config load failures or Claude CLI errors. These propagate to the main error handler but the root cause (missing mount) isn't obvious from the Slack error message.
- **Git credential failures** — If `.git-credentials` isn't mounted or is invalid, Claude CLI git operations fail silently from the user's perspective (Claude reports the error in its response).

## Proposed Solution

### 1. Add a `warnInThread` helper

A lightweight function that posts a non-blocking warning to the Slack thread. Failures to post the warning itself are silently caught (no cascading errors).

```typescript
async function warnInThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  message: string,
): Promise<void> {
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:warning: ${message}`,
    });
  } catch {
    // If we can't even post the warning, just log it
    console.error(`[warn] Failed to post warning to thread: ${message}`);
  }
}
```

### 2. Apply to subsidiary operations

Each subsidiary operation should call `warnInThread` on failure, with a brief user-friendly message. The original `console.error` stays for ops debugging.

**File attachment uploads** (`tempdir.ts`):
```
:warning: Failed to upload attachment "CLAUDE.md" (missing_scope). Check bot permissions.
```

**File downloads** (`slack.ts` `downloadSlackFiles`):
```
:warning: Failed to download file "screenshot.png" (HTTP 403). Check bot token permissions.
```

**Config load failure** (`slack.ts`):
```
:warning: Failed to load config — message skipped. Check server logs.
```

**Thread context fetch** (`thread.ts`):
```
:warning: Could not load thread history — responding without context.
```

### 3. What stays silent

- **Streaming update failures** — Transient, self-recovering. Logging is enough.
- **Reactions** — Non-critical UI hints, already handled by `safeReact`.
- **Cleanup operations** — Internal housekeeping, no user impact.
- **Tool status messages** — Ephemeral indicators, not worth warning about.
- **Queue file corruption** — Internal recovery, no user-visible impact.

### 4. Threading `client` + thread context through

Some functions (e.g., `uploadAttachedFiles`, `fetchThreadContext`) already receive `client`, `channelId`, and `threadTs`. The `warnInThread` call can be added directly.

`downloadSlackFiles` currently receives only `files`, `token`, and `channelId`. It would need `client` and `threadTs` added to post warnings, or the caller handles warnings based on return value.

**Option A — Pass thread context to subsidiary functions:**
Add `client` + `threadTs` params where needed. Simple, explicit.

**Option B — Collect warnings and post after:**
Subsidiary functions return a list of warnings. The caller posts them. More flexible, avoids threading Slack client deeply.

**Recommendation:** Option A for functions that already have `client` (most of them). Option B for `downloadSlackFiles` since the caller already has the thread context.

### 5. Fix unhandled error in magic commands

`handleMagicCommand` in `commands.ts` calls `loadConfig()` without try-catch. Wrap it to prevent unhandled throws:

```typescript
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  await client.chat.postMessage({
    channel, thread_ts: threadTs,
    text: ':warning: Failed to load config. Check server logs.',
  });
  return true;
}
```

## Implementation Checklist

- [x] Add `warnInThread` helper to `slack-utils.ts`
- [x] `downloadSlackFiles` — return `{paths, failedCount, totalCount}`; caller posts batch warning via `warnInThread`
- [ ] `uploadAttachedFiles` — call `warnInThread` on per-file upload failure
- [x] `processQueuedMessage` config load failure — call `warnInThread` before dequeuing
- [x] `fetchThreadContext` — call `warnInThread` on fetch failure
- [x] `handleMagicCommand` — wrap `loadConfig()` in try-catch with Slack feedback
- [x] Review: avoid spamming if multiple files fail (batch summary per operation)
- [ ] Verify Docker log output captures all `console.error` calls for ops visibility
