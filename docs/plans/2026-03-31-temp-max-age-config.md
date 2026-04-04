# Configurable Temp File Cleanup

**Date:** 2026-03-31

**Status:** Implemented

## Goal

Replace the hardcoded 24-hour temp file cleanup with a configurable `tempMaxAgeDays` setting under `defaults` in `config.yaml`. All three temp artifact types should be covered by a single setting.

## Background

Currently, `cleanupOldTempFiles()` in `src/index.ts` deletes Slack download files (`.docker/files/`) older than 24 hours at startup. Two other temp artifact types have no cleanup:
- Orphaned `req-*` dirs in `.claudeway-tmp/` (left by crashes)
- Scratch dirs in `.claudeway-tmp/scratch/` (designed to persist, but accumulate indefinitely)

## Design

### Config

- **Key:** `defaults.tempMaxAgeDays` (number)
- **Default:** `90` — delete temp artifacts older than 90 days on startup
- **Behavior:** On startup, delete all temp artifacts (across all three systems) whose age exceeds the threshold. `0` disables cleanup entirely.

### Type changes

Add `tempMaxAgeDays?: number` to the `Defaults` interface in `src/config.ts`.

### Cleanup logic

Extract cleanup into a new function in `src/tempdir.ts` (where temp dir logic already lives):

```typescript
export function cleanupStaleTempFiles(tempMaxAgeDays: number, tempBaseDir: string): void
```

This function handles all three artifact types:
1. **Slack downloads** (`.docker/files/`) — delete files with mtime > cutoff, remove empty channel dirs
2. **Orphaned req-* dirs** (`<tempBaseDir>/req-*`) — delete dirs with mtime > cutoff
3. **Stale scratch dirs** (`<tempBaseDir>/scratch/*`) — walk the subtree, compute the newest mtime of any file inside, only delete the channel scratch dir when that max mtime is older than the cutoff (directory mtime alone is unreliable — it changes on entry create/remove but not on in-place file edits)
4. **Stale pointer files** (`<tempBaseDir>/*.current`) — delete pointer files with mtime > cutoff

Short-circuit if `tempMaxAgeDays <= 0`.

### Startup integration

In `src/index.ts`, replace the inline `cleanupOldTempFiles()` call with:
1. Load config (move `loadConfig()` earlier, or just read the single field)
2. Call `cleanupStaleTempFiles(config.defaults.tempMaxAgeDays ?? 90, resolvedTempDir(config))`

Since `loadConfig()` is already called at line 130, we can either move it earlier or do a lightweight read of just this field. Moving `loadConfig()` earlier is cleaner since we already need `config` for adapter boot.

### Files to modify

| File | Change |
|---|---|
| `src/config.ts` | Add `tempMaxAgeDays?: number` to `Defaults` interface |
| `src/tempdir.ts` | Add `cleanupStaleTempFiles()` function |
| `src/index.ts` | Replace `cleanupOldTempFiles()` with new function, reorder startup |
| `config.example.yaml` | Add commented-out `tempMaxAgeDays` with default note |
| `config.yaml` | Add `tempMaxAgeDays: 0` to defaults |
| `README.md` | Document the new setting |
| `docs/TODO.md` | Mark file removal task as done |

### Tests

Add `src/__tests__/tempdir-cleanup.test.ts` covering:
- **Disabled behavior:** `tempMaxAgeDays: 0` skips all cleanup
- **Default behavior:** `tempMaxAgeDays: 90` deletes old artifacts, keeps recent ones
- **Slack downloads:** files older than cutoff deleted, recent ones kept, empty channel dirs removed
- **Orphaned req dirs:** old `req-*` dirs deleted, recent ones kept
- **Scratch dir safety:** scratch dir with old directory mtime but recently-edited file inside is NOT deleted; scratch dir where all files are old IS deleted
- **Pointer files:** stale `.current` files deleted
- **Non-existent dirs:** no errors when temp dirs don't exist
- **Negative values:** treated same as 0 (disabled)

### Edge cases

- `tempMaxAgeDays: 0` — disabled, no cleanup
- Missing/undefined — defaults to 90
- Negative values — treated as 0 (disabled)
- Non-existent temp dirs — silently skip (already handled)
- Files created during current startup — safe, mtime will be recent
- Scratch dir with old dir mtime but fresh file contents — safe, uses max file mtime from subtree walk
