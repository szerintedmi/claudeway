import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  resolveUserPermissions,
  resolvedTempDir,
  type ResolvedChannelConfig,
  type UserPermissions,
} from '../config.js';
import { runClaude, runClaudeStreaming, runClaudePersistentStreaming } from '../claude.js';
import { dequeue, getPendingForChannel, type QueuedMessage } from '../queue.js';
import { appendAccessRestrictions } from '../prompt.js';
import {
  createRequestTempDir,
  cleanupRequestTempDir,
  ensureScratchDir,
  readAttachmentManifest,
} from '../tempdir.js';
import type { ChannelResponder } from './interfaces.js';

// Re-export QueuedMessage for consumers
export type { QueuedMessage } from '../queue.js';

// Per-channel processing lock — one message at a time per channel
export const channelBusy = new Set<string>();

// Messages currently being processed (file still on disk but data already in memory)
const processingMessages = new Set<string>();
const processingKey = (channelId: string, ts: string) => `${channelId}_${ts}`;

export function isMessageProcessing(channelId: string, ts: string): boolean {
  return processingMessages.has(processingKey(channelId, ts));
}

// Global concurrency limit for Claude CLI processes
export const MAX_CONCURRENT_PROCESSES = 8;
let activeProcesses = 0;
const concurrencyWaiters: (() => void)[] = [];

async function acquireProcessSlot(): Promise<void> {
  if (activeProcesses < MAX_CONCURRENT_PROCESSES) {
    activeProcesses++;
    return;
  }
  await new Promise<void>((resolve) => concurrencyWaiters.push(resolve));
  activeProcesses++;
}

function releaseProcessSlot(): void {
  activeProcesses--;
  const next = concurrencyWaiters.shift();
  if (next) next();
}

interface PermissionContext {
  userPermissions: UserPermissions;
  userName?: string;
  channelName: string;
  scratchDir: string;
}

export async function processQueuedMessage(
  queued: QueuedMessage,
  responder: ChannelResponder,
): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err);
    await responder.warn('Failed to load config — message skipped. Check server logs.');
    dequeue(queued.channelId, queued.ts);
    return;
  }

  const resolvedCh = resolvedChannelConfig(config, queued.channelId);
  const channelConfig = resolvedCh
    ? resolvedCh
    : queued.channelId.startsWith('D') && config.botOwner
      ? resolvedDmConfig(config)
      : null;
  if (!channelConfig) {
    dequeue(queued.channelId, queued.ts);
    return;
  }

  // Resolve user permissions and prepare effective config
  const permissions = resolveUserPermissions(config, queued.channelId, queued.userId);
  const baseDir = resolvedTempDir(config);
  const scratchDir = ensureScratchDir(baseDir, queued.channelId);
  const effectiveSystemPrompt = appendAccessRestrictions(
    channelConfig.systemPrompt,
    permissions,
    scratchDir,
  );
  const effectiveConfig: ResolvedChannelConfig = {
    ...channelConfig,
    systemPrompt: effectiveSystemPrompt,
  };

  processingMessages.add(processingKey(queued.channelId, queued.ts));
  await responder.onProcessing();

  const mode = effectiveConfig.responseMode;

  // Wait for a process slot if at global concurrency limit
  if (activeProcesses >= MAX_CONCURRENT_PROCESSES) {
    console.log(
      `[${effectiveConfig.name}] Waiting for process slot (${activeProcesses}/${MAX_CONCURRENT_PROCESSES} active)`,
    );
  }
  await acquireProcessSlot();

  const processMode = effectiveConfig.processMode;
  // Strip user directory and thread context headers to show just the user's message
  const logText = queued.text
    .replace(/^\[[^\]]+ reference\][\s\S]*?\n\n/, '')
    .replace(/^\[Thread context[\s\S]*?\[Current message\]\n/, '');
  console.log(
    `[${effectiveConfig.name}] Processing (${processMode}/${mode}): ${logText.substring(0, 80)}...`,
  );

  const tempDir = createRequestTempDir(baseDir, queued.channelId);

  // Permission context passed through to Claude spawn
  const permCtx: PermissionContext = {
    userPermissions: permissions,
    userName: queued.userName,
    channelName: channelConfig.name,
    scratchDir,
  };

  try {
    if (mode === 'batch') {
      // Batch mode — run Claude, get full response, send at once
      const claudeOpts = {
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        effort: effectiveConfig.effort,
        systemPrompt: effectiveConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        ...(processMode === 'persistent' ? { tempBaseDir: baseDir } : {}),
        ...permCtx,
      };

      const result =
        processMode === 'persistent'
          ? await runClaudePersistentStreaming({ ...claudeOpts, onTextDelta: () => {} })
          : await runClaude(claudeOpts);

      await responder.sendResponse(result.response);
      await responder.onComplete();

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } else {
      // Streaming modes (stream-update or stream-native)
      const sr = responder.createStreamingResponder();

      const claudeStreamOpts = {
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        effort: effectiveConfig.effort,
        systemPrompt: effectiveConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        ...(processMode === 'persistent' ? { tempBaseDir: baseDir } : {}),
        onTextDelta: (text: string) => sr.onTextDelta(text),
        onToolEvent: (event: import('../claude.js').ToolEventPayload) => sr.onToolEvent(event),
        onProcessSpawned: sr.onProcessSpawned
          ? (kill: () => void) => sr.onProcessSpawned!(kill)
          : undefined,
        ...permCtx,
      };

      const result =
        processMode === 'persistent'
          ? await runClaudePersistentStreaming(claudeStreamOpts)
          : await runClaudeStreaming(claudeStreamOpts);

      await sr.finish();

      const finalText = result.response || sr.getFullText();
      await responder.onStreamComplete(finalText, sr);
      await responder.onComplete();

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${channelConfig.name}] Error:`, errorMsg);
    try {
      await responder.onError(errorMsg);
    } catch (e) {
      console.error('[engine] onError threw:', e);
    }
  } finally {
    // Upload any files Claude attached, then clean up
    const attachedFiles = readAttachmentManifest(tempDir);
    const failedUploads: string[] = [];
    for (const filePath of attachedFiles) {
      try {
        await responder.uploadFile(filePath);
      } catch (err) {
        const { basename } = await import('path');
        console.error(`[engine] Failed to upload attachment:`, err);
        failedUploads.push(basename(filePath));
      }
    }
    if (failedUploads.length > 0) {
      try {
        await responder.warn(
          `Failed to upload ${failedUploads.length} attachment(s): ${failedUploads.join(', ')}`,
        );
      } catch {
        // Best effort — don't let warning failure block cleanup
      }
    }
    cleanupRequestTempDir(tempDir, baseDir, queued.channelId);

    // Remove from persistent queue after processing (success or error)
    dequeue(queued.channelId, queued.ts);
    processingMessages.delete(processingKey(queued.channelId, queued.ts));
    releaseProcessSlot();
  }
}

export async function drainChannel(
  channelId: string,
  responderFactory: (queued: QueuedMessage) => ChannelResponder,
): Promise<void> {
  channelBusy.add(channelId);

  try {
    let pending = getPendingForChannel(channelId);
    while (pending.length > 0) {
      const queued = pending[0];
      const responder = responderFactory(queued);
      await processQueuedMessage(queued, responder);
      pending = getPendingForChannel(channelId);
    }
  } finally {
    channelBusy.delete(channelId);
  }
}
