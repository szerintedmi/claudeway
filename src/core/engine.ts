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
import {
  runClaude,
  runClaudeStreaming,
  runClaudePersistentStreaming,
  resolveSessionState,
} from '../claude.js';
import { resolveUserCredentials, type ResolvedCredentials } from '../credentials.js';
import { credsDmInstruction } from '../creds-hint.js';
import { buildCredentialStatus } from '../prompt.js';
import { scrubSecrets } from '../secrets.js';
import { audit } from '../audit.js';
import { ensureThreadWorktree } from '../worktrees.js';
import { dequeue, getPendingForChannel, type QueuedMessage } from '../queue.js';
import { resolveSessionTempDir, drainAttachmentManifest } from '../tempdir.js';
import type { ChannelResponder, IStreamingResponder, PromptCoordinator } from './interfaces.js';

// Re-export QueuedMessage for consumers
export type { QueuedMessage } from '../queue.js';
export type { PromptCoordinator } from './interfaces.js';

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
  credentials: ResolvedCredentials;
  isBotOwner: boolean;
}

export async function processQueuedMessage(
  queued: QueuedMessage,
  responder: ChannelResponder,
  coordinator?: PromptCoordinator,
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
    await responder
      .warn(
        `This server requires your own Claude credential — run \`claude setup-token\` on your own machine, then ${credsDmInstruction('connect it')} and resend your message here.`,
      )
      .catch(() => {});
    dequeue(queued.channelId, queued.ts);
    return;
  }

  const baseDir = resolvedTempDir(config);

  // Tell the agent which credentials this user is running on shared/absent
  // tokens for, so it warns preemptively instead of attempting doomed writes.
  // Slack senders get their mention token (consistent with the user directory
  // block); voice senders fall back to the registry name / canonical id.
  const userLabel = /^U[A-Z0-9]+$/.test(queued.userId)
    ? `<@${queued.userId}>${user.name ? ` (${user.name})` : ''}`
    : (user.name ?? user.userId);
  const effectiveConfig: ResolvedChannelConfig = {
    ...channelConfig,
    systemPrompt:
      channelConfig.systemPrompt + buildCredentialStatus(credentials.statuses, userLabel),
  };

  processingMessages.add(processingKey(queued.channelId, queued.ts));

  // Everything after the processing marker is added runs inside this try/finally
  // so a throw during setup (temp dir, worktree, prompt) still releases the
  // process slot, clears the processing marker, and dequeues the message.
  // Otherwise each failed drain would leak one of the 8 global process slots
  // until every channel deadlocks. Track what was actually acquired/created so
  // the finally only tears down real resources.
  let slotAcquired = false;
  let tempDir: string | undefined;
  // Hoisted so the finally block can finalize the stream even if the runner
  // throws — otherwise the native keepalive timer would leak and keep calling Slack.
  let sr: IStreamingResponder | null = null;
  let streamFinished = false;
  let streamErrorMsg: string | undefined;

  try {
    await responder.onProcessing();

    const mode = effectiveConfig.responseMode;

    // Wait for a process slot if at global concurrency limit
    if (activeProcesses >= MAX_CONCURRENT_PROCESSES) {
      console.log(
        `[${effectiveConfig.name}] Waiting for process slot (${activeProcesses}/${MAX_CONCURRENT_PROCESSES} active)`,
      );
    }
    await acquireProcessSlot();
    slotAcquired = true;

    const processMode = effectiveConfig.processMode;
    // Structured entries carry the raw text directly; legacy pre-rendered
    // prompts still need the old header stripping for a readable log line
    const logText =
      queued.slack?.rawText ??
      queued.text
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

    // Permission context passed through to Claude spawn — keyed on the CANONICAL
    // user id so the secret store, audit log, and process identity all agree
    const permCtx: PermissionContext = {
      config,
      userPermissions: permissions,
      userId: user.userId,
      userName: user.name ?? queued.userName,
      channelName: channelConfig.name,
      credentials,
      isBotOwner: user.isBotOwner,
    };

    // Per-thread worktree (decision #9): repo-backed channels run each thread in
    // its own worktree so concurrent threads don't collide and thread participants
    // share files. Session IDs keep deriving from the logical repo folder.
    let cwd = channelConfig.folder;
    let sessionFolder: string | undefined;
    const systemPrompt = effectiveConfig.systemPrompt;
    const repoName = (channelConfig as { repo?: string }).repo;
    const worktreesEnabled =
      (channelConfig as { threadWorktrees?: boolean }).threadWorktrees ?? true;
    if (config.repos && repoName && queued.threadTs && worktreesEnabled) {
      const worktree = ensureThreadWorktree(repoName, queued.channelId, queued.threadTs, {
        baseBranch: config.repos[repoName]?.branch,
      });
      if (worktree) {
        cwd = worktree;
        sessionFolder = channelConfig.folder;
      }
    }

    // Resolve session state ONCE for prompt rendering and the runners' --resume
    // decision — the artifact path encodes the resolved cwd (worktree), so this
    // must happen after worktree resolution.
    const session = resolveSessionState({
      channelId: queued.channelId,
      cwd,
      sessionFolder,
      threadTs: queued.threadTs,
    });

    // One temp dir per resolved session, holding inbound downloads, generated
    // files, generic tool temp, and the outbound manifest. Created AFTER session
    // resolution so it keys on the resolved sessionId (D1), and before the
    // runners so the spawn env can point CLAUDEWAY_TEMP_DIR/TMPDIR at it.
    tempDir = resolveSessionTempDir(baseDir, queued.channelId, session.sessionId);

    // Render-at-processing-time (structured Slack entries): history selection
    // and inbound-file download happen here, not at enqueue, so queued turns see
    // what Claude has actually received and downloads land in the resolved
    // session's incoming/. Legacy entries pass their pre-rendered text through.
    const rendered =
      coordinator && queued.slack
        ? await coordinator.prepare(queued, session, { sessionTempDir: tempDir })
        : null;
    const message = rendered ? rendered.text : queued.text;
    // Forward non-fatal download warnings — a failed/oversized download warns
    // and the turn proceeds without that file (never a throw, never silent).
    for (const w of rendered?.warnings ?? []) {
      await responder.warn(w).catch(() => {});
    }

    // Rendered prompts carry attachment info inline (ref= and path=), so the
    // generic "[Attached files ...]" footer would duplicate it. Unrendered
    // messages keep the footer — it is their only pointer to the local files.
    // filePaths stays on the queue entry for restart/bookkeeping either way.
    const runnerFilePaths = rendered ? undefined : queued.filePaths;

    // Advance the Slack history watermark only after Claude actually completed
    // the turn — a failed turn must re-inject (duplication over loss).
    const commitTurn = async () => {
      if (!coordinator || !queued.slack) return;
      try {
        await coordinator.onTurnCommitted(queued, session);
      } catch (err) {
        console.warn(`[${channelConfig.name}] Failed to advance Slack history watermark:`, err);
      }
    };

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

    if (mode === 'batch') {
      // Batch mode — run Claude, get full response, send at once
      const claudeOpts = {
        message,
        cwd,
        sessionFolder,
        session,
        model,
        effort,
        systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: runnerFilePaths,
        tempDir,
        ...permCtx,
      };

      const result =
        processMode === 'persistent'
          ? await runClaudePersistentStreaming({ ...claudeOpts, onTextDelta: () => {} })
          : await runClaude(claudeOpts);

      await commitTurn();
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
        message,
        cwd,
        sessionFolder,
        session,
        model,
        effort,
        systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        threadTs: queued.threadTs,
        filePaths: runnerFilePaths,
        tempDir,
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

      await commitTurn();
      await streamer.finish();
      streamFinished = true;

      const finalText = result.response || streamer.getFullText();
      await responder.onStreamComplete(finalText, streamer, {
        authoritative: result.response.trim().length > 0,
      });
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
    streamErrorMsg = errorMsg;
    console.error(`[${channelConfig.name}] Error:`, errorMsg);
    try {
      await responder.onError(errorMsg);
    } catch (e) {
      console.error('[engine] onError threw:', e);
    }
  } finally {
    // If the runner threw before finish() ran, finalize the stream here with the
    // failure outcome so the live UI is closed out (open task cards flip to
    // error, the stream is stopped, keepalive timers are cleared) — the work log
    // must never be left dangling/expanded.
    if (sr && !streamFinished) {
      try {
        await sr.finish({ ok: false, errorMessage: streamErrorMsg });
      } catch (e) {
        console.error('[engine] stream finalize during cleanup failed:', e);
      }
    }

    // Upload any files Claude staged this turn, then clear the manifest ONLY —
    // the files persist in the session temp dir so Claude can re-read/re-send
    // them in a later turn, and clearing prevents re-uploading them every
    // subsequent turn (D3). Only if the temp dir was created (setup may have
    // thrown before this point).
    if (tempDir) {
      const attachedFiles = drainAttachmentManifest(tempDir);
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
    }

    // Remove from persistent queue after processing (success or error)
    dequeue(queued.channelId, queued.ts);
    processingMessages.delete(processingKey(queued.channelId, queued.ts));
    if (slotAcquired) releaseProcessSlot();
  }
}

export async function drainChannel(
  channelId: string,
  responderFactory: (queued: QueuedMessage) => ChannelResponder,
  coordinator?: PromptCoordinator,
): Promise<void> {
  channelBusy.add(channelId);

  try {
    let pending = getPendingForChannel(channelId);
    while (pending.length > 0) {
      const queued = pending[0];
      const responder = responderFactory(queued);
      await processQueuedMessage(queued, responder, coordinator);
      pending = getPendingForChannel(channelId);
    }
  } finally {
    channelBusy.delete(channelId);
  }
}
