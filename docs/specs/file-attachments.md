# File Attachment Support

## Overview

Generalize Claudeway's existing image-only attachment handling to support **all downloadable file types** from Slack. Files are downloaded to a temp directory and their paths passed to Claude CLI, which can read them via its Read tool.

## Motivation

Today, only image attachments (PNG, JPEG, GIF, WebP) are downloaded and passed to Claude. All other file types — PDFs, code files, CSVs, text documents, etc. — are silently ignored. Since Claude CLI's Read tool can handle a wide variety of file formats (text, images, PDFs, notebooks), there's no reason to restrict downloads by MIME type.

## Requirements

### R1: Download any file type

- Remove the `SUPPORTED_IMAGE_TYPES` MIME type filter. Any Slack file with a `url_private_download` URL is eligible for download.
- Update the `hasImages` gate in the message handler (`registerMessageHandler`) to `hasFiles` — check for any file with `url_private_download` without a MIME type filter. Without this, text-free messages containing non-image files (e.g., a PDF dropped without comment) would be silently ignored.
- Increase the per-file size limit from 5MB to 25MB. This covers virtually all text-based files and typical document exports while preventing runaway temp disk usage from large binary attachments.

### R2: Generalize naming

- Rename image-specific concepts throughout the codebase:
  - `imagePaths` → `filePaths` (queue, options, local variables)
  - `downloadSlackImages` → `downloadSlackFiles`
  - `cleanupImages` → `cleanupFiles`
  - `IMAGE_SIZE_LIMIT` → `FILE_SIZE_LIMIT`
  - `IMAGE_TEMP_DIR` → `FILE_TEMP_DIR` (path: `/tmp/claudeway-files/`)
  - Remove `SUPPORTED_IMAGE_TYPES` constant entirely

### R3: Update Claude prompt instruction

- Change `[Attached image files — use your Read tool to view them]` to `[Attached files — use your Read tool to view them]`

### R4: Update default fallback text

- When a message has files but no text, change the default from `'What is in this image?'` to `'Please review the attached file(s).'`

### R5: Backwards compatibility with queued messages

- The `QueuedMessage` interface keeps the legacy `imagePaths?: string[]` field alongside the new `filePaths?: string[]` field.
- All consumers resolve file paths as `queued.filePaths ?? queued.imagePaths`, so messages queued before this change (surviving a restart) are still processed correctly.
- New messages are enqueued with `filePaths` only.

## File Storage Considerations

### Current approach: Ephemeral temp files

Files are downloaded to `/tmp/claudeway-files/`, passed to Claude CLI by path, and deleted in a `finally` block after processing completes. This is the simplest approach and works for the current single-message flow.

### Limitations of ephemeral storage

1. **Queue persistence mismatch**: The queue is durable (survives restarts), but temp files are not. If the process restarts after a message is queued but before it's processed, the `filePaths` in the queued message point to deleted files. This is the same existing bug with `imagePaths` — not new to this change.

2. **Thread context file gaps**: The thread context feature (implemented in `src/thread.ts`) injects text from prior thread messages into the prompt. However, it only extracts `text` — files attached to prior thread messages are completely invisible to Claude. If someone shares a file earlier in a thread and then asks Claude to analyze it via `@mention`, Claude won't have access to that file. Extending thread context to include file references would require durable storage (since those files were never downloaded), making this a future concern.

3. **Multi-turn sessions**: In persistent/streaming modes, Claude maintains a session. If Claude refers back to a file from a previous message in the same session, the temp file has already been cleaned up.

### Future consideration: Durable file storage

A more robust approach would store downloaded files in a durable location (e.g., `.files/` within the channel's working directory) with a retention policy. This would:

- Survive process restarts (fixing the queue persistence mismatch)
- Enable future thread context file references
- Allow Claude to reference files across turns in a session

This is explicitly **out of scope** for the initial implementation. The ephemeral model matches current behavior and is sufficient for the single-turn, single-message use case. Durable storage should be considered alongside per-thread sessions and thread-context file access.

### Cleanup safety

- The `cleanupFiles()` function runs in `finally` blocks, ensuring files are cleaned up even on errors.
- Files are namespaced by Slack file ID (`{file.id}-{file.name}`), preventing collisions.
- The temp directory uses `mkdirSync({ recursive: true })`, safe for concurrent creation.

## Files to Modify

| File | Changes |
|------|---------|
| `src/queue.ts` | Add `filePaths?: string[]` to `QueuedMessage`, keep `imagePaths?` as legacy |
| `src/claude.ts` | Rename `imagePaths` → `filePaths` in `ClaudeOptions`, `buildClaudeArgs()`, `runClaudePersistentStreaming()` |
| `src/slack.ts` | Remove MIME filter, rename constants/functions, update message handler and all six process functions |

## Edge Cases

1. **Binary files**: Claude's Read tool may not meaningfully read binary formats (e.g., `.zip`, `.exe`). This is acceptable — Claude will report it can't read the file, which is better than silently dropping it.
2. **Very large files**: The 25MB limit prevents most problematic files. Files exceeding the limit are silently skipped (logged to console).
3. **No `url_private_download`**: Some Slack file types (e.g., external links, Google Drive references) don't have a download URL. These are naturally filtered out by the existing `url_private_download` check.
4. **Duplicate filenames**: Files are prefixed with their Slack file ID, so duplicates are impossible.

## Non-Requirements (Out of Scope)

- **File type detection or special handling**: No MIME-type-specific logic. All files are treated uniformly — downloaded and passed as paths.
- **File content extraction**: No server-side text extraction from PDFs, Office documents, etc. Claude CLI handles this via its Read tool.
- **Durable file storage**: See "Future consideration" above.
- **Thread context file downloads**: Only files from the triggering message are downloaded. Files attached to prior thread messages are not included (thread context in `src/thread.ts` only extracts text). This is a known gap — see "File Storage Considerations" above.
- **Configurable size limit**: The 25MB limit is a constant. Per-channel configuration can be added later if needed.

## Verification

1. `bun run typecheck` — no type errors from the rename
2. `bun run lint` — pass lint
3. `bun test` — existing tests pass (none reference image-specific names)
4. Manual test: send a `.txt` file, a `.pdf`, a code file, and an image to Slack — all should be downloaded and passed to Claude
