import {
  loadConfig,
  resolvedChannelConfig,
  resolvedDmConfig,
  resolveUser,
  resolvedTempDir,
  botOwnerIds,
  isEffortLevel,
  type ResolvedChannelConfig,
  type UserPermissions,
} from '../config.js';
import { runClaude, runClaudeStreaming, runClaudePersistentStreaming } from '../claude.js';
import { resolveUserCredentials, type ResolvedCredentials } from '../credentials.js';
import { scrubSecrets } from '../secrets.js';
import { audit } from '../audit.js';
import { ensureThreadWorktree } from '../worktrees.js';
import { dequeue, getPendingForChannel, type QueuedMessage } from '../queue.js';
import {
  createRequestTempDir,
  cleanupRequestTempDir,
  ensureScratchDir,
  readAttachmentManifest,
} from '../tempdir.js';
import type { ChannelResponder, IStreamingResponder } from './interfaces.js';

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
  config: import('../config.js').Config;
  userPermissions: UserPermissions;
  /** Canonical user id (users: registry key when registered). */
  userId: string;
  userName?: string;
  channelName: string;
  scratchDir: string;
  credentials: ResolvedCredentials;
  isBotOwner: boolean;
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
    : queued.channelId.startsWith('D') && botOwnerIds(config).length > 0
      ? resolvedDmConfig(config)
      : null;
  if (!channelConfig) {
    dequeue(queued.channelId, queued.ts);
    return;
  }

  // Resolve canonical user identity + permissions and prepare effective config
  const user = resolveUser(config, queued.channelId, queued.userId);
  const permissions = user.permissions;

  // Resolve credentials (personal > explicit shared default > unset)
  const credentials = resolveUserCredentials(config, user.userId);

  // BYO Claude hard gate: when userCredentials.claude is configured, every
  // user — bot owner included — must run on their own enrolled token. An
  // unconfigured registry keeps today's behavior (owner's ~/.claude auth).
  if (credentials.missingClaudeCred) {
    audit({
      event: 'spawn.denied',
      userId: user.userId,
      userName: user.name ?? queued.userName,
      channelId: queued.channelId,
      credNames: ['claude'],
      detail: 'no personal Claude credential',
    });
    // Mentioning the bot renders a clickable link that opens its profile/DM
    const botRef = queued.botUserId ? `<@${queued.botUserId}>` : 'me';
    await responder
      .warn(
        `This server requires your own Claude credential — DM ${botRef} \`!creds\` to connect it, then resend your message.`,
      )
      .catch(() => {});
    dequeue(queued.channelId, queued.ts);
    return;
  }

  const baseDir = resolvedTempDir(config);
  const scratchDir = ensureScratchDir(baseDir, queued.channelId);
  const effectiveConfig: ResolvedChannelConfig = {
    ...channelConfig,
    systemPrompt: channelConfig.systemPrompt,
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
  const modelSuffix = queued.modelOverride ? ` [model: ${queued.modelOverride}]` : '';
  const effortSuffix = queued.effortOverride ? ` [effort: ${queued.effortOverride}]` : '';
  console.log(
    `[${effectiveConfig.name}] Processing (${processMode}/${mode})${modelSuffix}${effortSuffix}: ${logText.substring(0, 80)}...`,
  );

  // Resolve per-turn overrides once for both runner branches. The engine is the
  // chokepoint every adapter funnels through, and queue files are plain JSON read
  // back from disk — re-validate the effort instead of trusting the static type.
  const model = queued.modelOverride ?? channelConfig.model;
  let effort = effectiveConfig.effort;
  if (queued.effortOverride) {
    if (isEffortLevel(queued.effortOverride)) {
      effort = queued.effortOverride;
    } else {
      console.warn(
        `[${effectiveConfig.name}] Ignoring unknown effort override '${queued.effortOverride}' from queue`,
      );
    }
  }

  const tempDir = createRequestTempDir(baseDir, queued.channelId);

  // Permission context passed through to Claude spawn — keyed on the CANONICAL
  // user id so the secret store, audit log, and process identity all agree
  const permCtx: PermissionContext = {
    config,
    userPermissions: permissions,
    userId: user.userId,
    userName: user.name ?? queued.userName,
    channelName: channelConfig.name,
    scratchDir,
    credentials,
    isBotOwner: user.isBotOwner,
  };

  // Per-thread worktree (decision #9): repo-backed channels run each thread in
  // its own worktree so concurrent threads don't collide and thread participants
  // share files. Session IDs keep deriving from the logical repo folder.
  let cwd = channelConfig.folder;
  let sessionFolder: string | undefined;
  const repoName = (channelConfig as { repo?: string }).repo;
  const worktreesEnabled = (channelConfig as { threadWorktrees?: boolean }).threadWorktrees ?? true;
  if (config.repos && repoName && queued.threadTs && worktreesEnabled) {
    const worktree = ensureThreadWorktree(repoName, queued.channelId, queued.threadTs, {
      baseBranch: config.repos[repoName]?.branch,
    });
    if (worktree) {
      cwd = worktree;
      sessionFolder = channelConfig.folder;
    }
  }

  // Audit which credential names (never values) back this spawn
  if (credentials.personalCredNames.length > 0 || credentials.sharedCredNames.length > 0) {
    audit({
      event: 'spawn',
      userId: user.userId,
      userName: permCtx.userName,
      channelId: queued.channelId,
      credNames: [
        ...credentials.personalCredNames,
        ...credentials.sharedCredNames.map((n) => `${n}(shared)`),
      ],
    });
  }

  // Hoisted so the finally block can finalize the stream even if the runner
  // throws — otherwise the native keepalive timer would leak and keep calling Slack.
  let sr: IStreamingResponder | null = null;
  let streamFinished = false;

  try {
    if (mode === 'batch') {
      // Batch mode — run Claude, get full response, send at once
      const claudeOpts = {
        message: queued.text,
        cwd,
        sessionFolder,
        model,
        effort,
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
      const streamer = responder.createStreamingResponder();
      sr = streamer;

      const claudeStreamOpts = {
        message: queued.text,
        cwd,
        sessionFolder,
        model,
        effort,
        systemPrompt: effectiveConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: queued.filePaths,
        tempDir,
        ...(processMode === 'persistent' ? { tempBaseDir: baseDir } : {}),
        onTextDelta: (text: string) => streamer.onTextDelta(text),
        onReasoningDelta: streamer.onReasoningDelta
          ? (text: string) => streamer.onReasoningDelta!(text)
          : undefined,
        onToolEvent: (event: import('../claude.js').ToolEventPayload) =>
          streamer.onToolEvent(event),
        onProcessSpawned: streamer.onProcessSpawned
          ? (kill: () => void) => streamer.onProcessSpawned!(kill)
          : undefined,
        ...permCtx,
      };

      const result =
        processMode === 'persistent'
          ? await runClaudePersistentStreaming(claudeStreamOpts)
          : await runClaudeStreaming(claudeStreamOpts);

      await streamer.finish();
      streamFinished = true;

      const finalText = result.response || streamer.getFullText();
      await responder.onStreamComplete(finalText, streamer);
      await responder.onComplete();

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    }
  } catch (err) {
    // Scrub secret values before the error reaches logs or the channel
    const errorMsg = scrubSecrets(
      err instanceof Error ? err.message : String(err),
      credentials.secretValues,
    );
    console.error(`[${channelConfig.name}] Error:`, errorMsg);
    try {
      await responder.onError(errorMsg);
    } catch (e) {
      console.error('[engine] onError threw:', e);
    }
  } finally {
    // If the runner threw before finish() ran, finalize the stream here so its
    // keepalive timer is cleared and the open stream is stopped (best effort).
    if (sr && !streamFinished) {
      try {
        await sr.finish();
      } catch (e) {
        console.error('[engine] stream finalize during cleanup failed:', e);
      }
    }

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
