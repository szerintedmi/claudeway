# Error Handling: User-Facing Feedback

## Problem

Errors in subsidiary operations (file uploads, image downloads, thread context, streaming updates) are logged to console but never communicated back to the Slack user. The user sees silence — no indication that something went wrong.

The main `processQueuedMessage` catch handler is the only path that posts errors to Slack. Everything else is console-only.

## Current State

### Has Slack feedback

- **Main processing errors** (`processQueuedMessage` catch) — posts `:warning: Error: ...` to thread, adds `:x:` reaction

### Console-only (no Slack feedback)

| Component | File | Behavior |
|---|---|---|
| Config load failure | `slack.ts` ~925 | Silently dequeues message, no feedback at all |
| File attachment uploads | `tempdir.ts` ~52 | Per-file catch, logs error, continues |
| Image downloads | `slack.ts` ~73 | Per-file catch, logs error, skips file |
| Streaming update failures | `slack.ts` ~264 | Catch in `flush()`, logs, continues |
| Native stream append | `slack.ts` ~415 | Promise `.catch()`, logs |
| Thread context fetch | `thread.ts` ~35 | Returns `[]` on error, logs |
| Queue drain errors | `slack.ts` ~1521 | `.catch()`, logs |

### Intentionally silent (acceptable)

| Component | Reason |
|---|---|
| Reactions (`safeReact`) | Non-critical UI hint |
| Temp dir cleanup | Best-effort filesystem cleanup |
| Message deletion during streaming | Best-effort, fallback exists |
| Tool status updates | Ephemeral progress indicators |

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

**Image downloads** (`slack.ts`):
```
:warning: Failed to download image "screenshot.png" (HTTP 403). Check bot token permissions.
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

### 4. Threading `client` + thread context through

Some functions (e.g., `uploadAttachedFiles`, `fetchThreadContext`) already receive `client`, `channelId`, and `threadTs`. The `warnInThread` call can be added directly.

For `downloadImages`, the Slack thread context (`channelId`, `threadTs`) is not currently passed — it would need to be added to the function signature or the caller would need to handle warnings based on the return value (e.g., return error info alongside paths).

**Option A — Pass thread context to subsidiary functions:**
Add `channelId` + `threadTs` params where needed. Simple, explicit.

**Option B — Collect warnings and post after:**
Subsidiary functions return a list of warnings. The caller posts them. More flexible, avoids threading Slack client deeply.

**Recommendation:** Option A for functions that already have `client` (most of them). Option B only if needed for functions that don't.

## Implementation Checklist

- [ ] Add `warnInThread` helper to `slack.ts`
- [ ] `uploadAttachedFiles` — call `warnInThread` on per-file upload failure
- [ ] `downloadImages` — call `warnInThread` on per-file download failure (needs thread context added to signature)
- [ ] `processQueuedMessage` config load failure — call `warnInThread` before dequeuing
- [ ] `fetchThreadContext` — call `warnInThread` on fetch failure (needs thread context — it already has `channelId` and `threadTs`)
- [ ] Review: avoid spamming if multiple files fail (consider batching warnings per operation)
