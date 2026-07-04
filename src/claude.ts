import { type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { spawnTrackedClaude } from './child-processes.js';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { resolve } from 'path';
import { v5 as uuidv5 } from 'uuid';
import {
  getConfigPath,
  permissionKey as permissionKeyStr,
  type Config,
  type UserPermissions,
} from './config.js';
import { getMcpConfigPath } from './mcp.js';
import { type ResolvedCredentials } from './credentials.js';
import {
  parseStreamLine,
  extractKeyArg,
  ToolUseAccumulators,
  type ToolEventPayload,
} from './claude-stream-parser.js';
import {
  buildAllowedEnv,
  buildSpawnEnv,
  buildInjectedEnv,
  processIdentityKey,
  scrub,
} from './claude-spawn-env.js';

// Re-export ProcessMode for consumers that only import from claude.ts
export type { ProcessMode } from './config.js';
// Re-export the stream-parser surface so existing importers of '../claude.js'
// (tests, the interfaces module) keep working after the split.
export { parseStreamLine } from './claude-stream-parser.js';
export type { ToolEventPayload, StreamLineEvent } from './claude-stream-parser.js';
// Re-export the spawn-env surface used by tests importing from '../claude.js'.
export { buildAllowedEnv, processIdentityKey } from './claude-spawn-env.js';

export interface ClaudeOptions {
  message: string;
  cwd: string;
  model: string;
  effort?: string;
  systemPrompt: string;
  timeoutMs: number;
  channelId: string;
  threadTs?: string;
  filePaths?: string[];
  tempDir?: string;
  tempBaseDir?: string;
  config: Config;
  userPermissions: UserPermissions;
  /** Canonical user id (users: registry key, or external id when unregistered). */
  userId: string;
  userName?: string;
  channelName?: string;
  scratchDir?: string;
  /** Resolved per-user credentials (env injection, git token, scrub values). */
  credentials?: ResolvedCredentials;
  /** True when the sender is the botOwner — the git adapter is skipped (own creds). */
  isBotOwner?: boolean;
  /**
   * Logical repo folder for session-ID derivation when cwd is a per-thread
   * worktree — keeps existing session IDs stable (merged-plan decision #9).
   */
  sessionFolder?: string;
}

export interface ClaudeStreamingOptions extends ClaudeOptions {
  onTextDelta: (text: string) => void;
  /** Extended-thinking deltas, surfaced separately from the final-answer text. */
  onReasoningDelta?: (text: string) => void;
  onToolEvent?: (event: ToolEventPayload) => void;
  /** Called after the Claude process is spawned, providing a kill function (SIGTERM) */
  onProcessSpawned?: (kill: () => void) => void;
}

export interface ClaudeResult {
  response: string;
  sessionId: string | null;
  cost: number | null;
  tokens: number | null;
}

// Claudeway namespace UUID for deterministic session IDs
const CLAUDEWAY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Append file path references to a message so Claude reads them via its Read tool */
function buildMessageWithFiles(message: string, filePaths: string[] | undefined): string {
  if (filePaths && filePaths.length > 0) {
    return `${message}\n\n[Attached files — use your Read tool to view them]\n${filePaths.join('\n')}`;
  }
  return message;
}

// Absolute maximum runtime — safety net regardless of activity
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Process registry for tracking and killing running Claude processes ---

interface ActiveProcess {
  proc: ChildProcess;
  channelId: string;
  sessionId: string;
  startedAt: Date;
  message: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
}

const processRegistry = new Map<string, ActiveProcess>();

/** Build a registry key from channelId and optional threadTs */
function registryKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// --- Persistent process registry ---

interface PersistentProcessEntry {
  proc: ChildProcess;
  channelId: string;
  sessionId: string;
  permissionKey: string;
  identityKey: string;
  startedAt: Date;
  lastMessage: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
  idleTimer: ReturnType<typeof setTimeout>;
  /**
   * Absolute cap on the process lifetime. A persistent process is reused across
   * turns and its idle timer resets on every byte of output, so without this it
   * could live forever (one-shot streaming has the same 12h cap).
   */
  absoluteTimer: ReturnType<typeof setTimeout>;
  lineBuffer: string;
  /** Stderr of the current turn (bounded; reset when a new turn is written to stdin) */
  stderrBuf: string;
  currentTurn: {
    resolve: (r: ClaudeResult) => void;
    reject: (e: Error) => void;
    onTextDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
    onToolEvent?: (event: ToolEventPayload) => void;
    fullText: string;
    sessionId: string | null;
    cost: number | null;
    toolAccums: ToolUseAccumulators;
  } | null;
}

const persistentRegistry = new Map<string, PersistentProcessEntry>();

export interface ActiveProcessInfo {
  channelId: string;
  sessionId: string;
  startedAt: Date;
  message: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
  isActive: boolean;
}

export function getActiveProcesses(): ActiveProcessInfo[] {
  const oneshot = Array.from(processRegistry.values()).map(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ proc, ...rest }) => ({ ...rest, isActive: true }),
  );
  const persistent = Array.from(persistentRegistry.values()).map((entry) => ({
    channelId: entry.channelId,
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    message: entry.lastMessage,
    messageCount: entry.messageCount,
    totalCost: entry.totalCost,
    totalTokens: entry.totalTokens,
    isActive: entry.currentTurn !== null,
  }));
  return [...oneshot, ...persistent];
}

export function killProcess(channelId: string): boolean {
  let killed = false;
  for (const [key, entry] of processRegistry) {
    if (key === channelId || key.startsWith(`${channelId}:`)) {
      entry.proc.kill('SIGTERM');
      killed = true;
    }
  }
  for (const [key, entry] of persistentRegistry) {
    if (key === channelId || key.startsWith(`${channelId}:`)) {
      clearTimeout(entry.idleTimer);
      clearTimeout(entry.absoluteTimer);
      entry.proc.kill('SIGTERM');
      killed = true;
    }
  }
  return killed;
}

export function nudgeProcess(channelId: string): boolean {
  let nudged = false;
  for (const [key, entry] of processRegistry) {
    if (key === channelId || key.startsWith(`${channelId}:`)) {
      entry.proc.kill('SIGINT');
      nudged = true;
    }
  }
  for (const [key, entry] of persistentRegistry) {
    if (key === channelId || key.startsWith(`${channelId}:`)) {
      entry.proc.kill('SIGINT');
      nudged = true;
    }
  }
  return nudged;
}

export function killAllProcesses(): string[] {
  const killed: string[] = [];
  for (const [channelId, entry] of processRegistry) {
    entry.proc.kill('SIGTERM');
    killed.push(channelId);
  }
  for (const [channelId, entry] of persistentRegistry) {
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.absoluteTimer);
    entry.proc.kill('SIGTERM');
    killed.push(channelId);
  }
  return killed;
}

/**
 * Generate a deterministic session UUID from channel ID + folder path.
 * Same channel+folder always produces the same session ID, surviving restarts.
 */
export function deriveSessionId(channelId: string, folder: string, threadTs?: string): string {
  return uuidv5(`${channelId}:${folder}${threadTs ? `:${threadTs}` : ''}`, CLAUDEWAY_NAMESPACE);
}

function spawnClaudeProcess(args: string[], cwd: string, env: Record<string, string>) {
  return spawnTrackedClaude(args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function runClaudeProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  channelId: string,
  sessionId: string,
  message: string,
  regKey: string,
  env: Record<string, string>,
  secretValues?: readonly string[],
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd, env);

    processRegistry.set(regKey, {
      proc,
      channelId,
      sessionId,
      startedAt: new Date(),
      message: message.substring(0, 80),
      messageCount: 1,
      totalCost: 0,
      totalTokens: 0,
    });

    let stdout = '';
    let stderr = '';

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
      }, timeoutMs);
    };

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
      resetTimer();
    });

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
      resetTimer();
    });

    let timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
    }, timeoutMs);

    const absoluteTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude absolute timeout after ${ABSOLUTE_TIMEOUT_MS / 3600000}h`));
    }, ABSOLUTE_TIMEOUT_MS);

    proc.on('close', (code) => {
      processRegistry.delete(regKey);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${scrub(stderr.trim(), secretValues)}`));
        return;
      }

      try {
        const json = JSON.parse(stdout);
        const usage = json.usage;
        resolve({
          response: json.result ?? json.content ?? stdout,
          sessionId: json.session_id ?? null,
          cost: json.cost_usd ?? null,
          tokens: usage != null ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null,
        });
      } catch {
        resolve({
          response: stdout.trim(),
          sessionId: null,
          cost: null,
          tokens: null,
        });
      }
    });

    proc.on('error', (err) => {
      processRegistry.delete(regKey);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function runClaudeStreamingProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onTextDelta: (text: string) => void,
  channelId: string,
  registrySessionId: string,
  message: string,
  regKey: string,
  onToolEvent?: (event: ToolEventPayload) => void,
  env?: Record<string, string>,
  onProcessSpawned?: (kill: () => void) => void,
  onReasoningDelta?: (text: string) => void,
  secretValues?: readonly string[],
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd, env ?? {});

    onProcessSpawned?.(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    });

    processRegistry.set(regKey, {
      proc,
      channelId,
      sessionId: registrySessionId,
      startedAt: new Date(),
      message: message.substring(0, 80),
      messageCount: 1,
      totalCost: 0,
      totalTokens: 0,
    });

    let stderr = '';
    let fullText = '';
    let sessionId: string | null = null;
    let cost: number | null = null;
    let tokens: number | null = null;
    let lineBuffer = '';
    const toolAccums = new ToolUseAccumulators();

    function processLine(line: string) {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.type === 'text_delta') {
        fullText += event.text;
        onTextDelta(event.text);
      } else if (event.type === 'reasoning_delta') {
        onReasoningDelta?.(event.text);
      } else if (event.type === 'result') {
        sessionId = event.sessionId ?? sessionId;
        cost = event.cost ?? cost;
        tokens = event.tokens ?? tokens;
        if (event.text) fullText = event.text;
      } else if (event.type === 'tool_start') {
        toolAccums.start(event.toolName, event.index);
        void onToolEvent?.({ phase: 'start', toolName: event.toolName, index: event.index });
      } else if (event.type === 'tool_input_delta') {
        toolAccums.appendInput(event.index, event.partialJson);
      } else if (event.type === 'tool_stop') {
        const acc = toolAccums.stop(event.index);
        if (acc) {
          void onToolEvent?.({
            phase: 'complete',
            toolName: acc.toolName,
            keyArg: extractKeyArg(acc.toolName, acc.partialJson),
            index: acc.index,
          });
        }
      } else if (event.type === 'subagent_progress') {
        void onToolEvent?.({
          phase: 'subagent_progress',
          toolName: event.toolName,
          description: event.description,
        });
      } else if (event.type === 'subagent_completed') {
        void onToolEvent?.({
          phase: 'subagent_completed',
          toolName: 'Agent',
          description: event.description,
          usage: event.usage,
        });
      }
    }

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
      }, timeoutMs);
    };

    let rawStdout = '';
    proc.stdout!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      rawStdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
      resetTimer();
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[claude-stderr] ${scrub(chunk.trimEnd(), secretValues)}`);
      resetTimer();
    });

    let timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
    }, timeoutMs);

    const absoluteTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude absolute timeout after ${ABSOLUTE_TIMEOUT_MS / 3600000}h`));
    }, ABSOLUTE_TIMEOUT_MS);

    proc.on('close', (code) => {
      processRegistry.delete(regKey);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      // Process any remaining buffered line
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
      }

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${scrub(stderr.trim(), secretValues)}`));
        return;
      }

      if (!fullText) {
        const details: string[] = [];
        if (stderr) details.push(`stderr: ${stderr.trimEnd().slice(-500)}`);
        if (rawStdout) details.push(`stdout(last 500): ${rawStdout.trimEnd().slice(-500)}`);
        const detail = details.length > 0 ? ` ${scrub(details.join(' | '), secretValues)}` : '';
        console.error(`[claude] Process produced no response (exit 0).${detail}`);
        reject(new Error('Claude process produced no response.'));
        return;
      }

      resolve({
        response: fullText,
        sessionId,
        cost,
        tokens,
      });
    });

    proc.on('error', (err) => {
      processRegistry.delete(regKey);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Resolve paths to all artifacts Claude CLI creates for a session.
 * Claude encodes folder paths by replacing / with - (keeping the leading dash).
 */
export function sessionArtifactPaths(sessionId: string, cwd: string) {
  const home = process.env.HOME ?? homedir();
  const encodedPath = cwd.replace(/[/.]/g, '-');
  return {
    jsonl: resolve(home, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`),
    dir: resolve(home, '.claude', 'projects', encodedPath, sessionId),
    todo: resolve(home, '.claude', 'todos', `${sessionId}-agent-${sessionId}.json`),
  };
}

/**
 * Remove all session artifacts so the session ID can be reused.
 * Called on "already in use" errors before retrying.
 */
function clearSessionArtifacts(sessionId: string, cwd: string): void {
  const paths = sessionArtifactPaths(sessionId, cwd);
  for (const [name, p] of Object.entries(paths)) {
    try {
      if (!existsSync(p)) continue;
      if (name === 'dir') {
        rmSync(p, { recursive: true, force: true });
      } else {
        unlinkSync(p);
      }
      console.log(`Cleared session artifact: ${p}`);
    } catch {
      // Ignore — file may already be gone or locked
    }
  }
}

function buildClaudeArgs(
  options: ClaudeOptions,
  outputFormat: 'json' | 'stream-json',
): { args: string[]; sessionId: string; cwd: string; resuming: boolean } {
  const { message, cwd: rawCwd, model, systemPrompt, channelId, threadTs } = options;
  const cwd = resolve(rawCwd);

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  // Session IDs derive from the LOGICAL repo folder, not the worktree path —
  // otherwise every pre-worktree session ID would change (decision #9 caveat).
  const sessionId = deriveSessionId(
    channelId,
    options.sessionFolder ? resolve(options.sessionFolder) : cwd,
    threadTs,
  );

  const { jsonl: sessionFile } = sessionArtifactPaths(sessionId, cwd);
  const resuming = existsSync(sessionFile);

  const args = [
    '-p',
    '--output-format',
    outputFormat,
    ...(outputFormat === 'stream-json' ? ['--verbose', '--include-partial-messages'] : []),
    '--model',
    model,
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--append-system-prompt',
    prompt,
  ];

  // --mcp-config is variadic (<configs...>) — it greedily consumes every
  // following non-flag arg. Insert it before another flag so the variadic
  // terminates and the trailing positional user message isn't slurped in.
  const mcpConfigPath = getMcpConfigPath(
    options.credentials?.readOnlyMcpServers ?? [],
    process.cwd(),
  );
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  // Only the gateway-provided MCP config may load — without this the subprocess
  // also picks up the operator's ~/.claude.json servers (and any personal
  // credentials embedded in them), bypassing per-user credential resolution.
  args.push('--strict-mcp-config');
  args.push('--dangerously-skip-permissions');

  args.push(buildMessageWithFiles(message, options.filePaths));

  return { args, sessionId, cwd, resuming };
}

function makeFreshArgs(args: string[], sessionId: string): string[] {
  return args.map((a, i) => (a === '--resume' && args[i + 1] === sessionId ? '--session-id' : a));
}

/**
 * Run `attempt(args)`; on a session "already in use" failure, clear the
 * session's artifacts and retry ONCE with a fresh (non-resume) arg set. Shared
 * by the oneshot and streaming runners (was duplicated in both).
 */
async function withSessionRetry<T>(
  channelId: string,
  sessionId: string,
  cwd: string,
  args: string[],
  attempt: (args: string[]) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await attempt(makeFreshArgs(args, sessionId));
    }
    throw err;
  }
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'json');
  const spawnEnv = buildSpawnEnv(options);
  const regKey = registryKey(options.channelId, options.threadTs);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} session ${sessionId} [${permissionKeyStr(options.userPermissions) || 'read-only'}]`,
  );

  const secretValues = options.credentials?.secretValues;

  return withSessionRetry(options.channelId, sessionId, cwd, args, (a) =>
    runClaudeProcess(
      a,
      cwd,
      options.timeoutMs,
      options.channelId,
      sessionId,
      options.message,
      regKey,
      spawnEnv,
      secretValues,
    ),
  );
}

export async function runClaudeStreaming(options: ClaudeStreamingOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'stream-json');
  const spawnEnv = buildSpawnEnv(options);
  const regKey = registryKey(options.channelId, options.threadTs);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} streaming session ${sessionId} [${permissionKeyStr(options.userPermissions) || 'read-only'}]`,
  );

  const secretValues = options.credentials?.secretValues;

  return withSessionRetry(options.channelId, sessionId, cwd, args, (a) =>
    runClaudeStreamingProcess(
      a,
      cwd,
      options.timeoutMs,
      options.onTextDelta,
      options.channelId,
      sessionId,
      options.message,
      regKey,
      options.onToolEvent,
      spawnEnv,
      options.onProcessSpawned,
      options.onReasoningDelta,
      secretValues,
    ),
  );
}

// --- Persistent process mode ---

function buildPersistentClaudeArgs(options: ClaudeOptions): {
  args: string[];
  sessionId: string;
  cwd: string;
  resuming: boolean;
} {
  const { cwd: rawCwd, model, systemPrompt, channelId, threadTs } = options;
  const cwd = resolve(rawCwd);

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  // See buildClaudeArgs: session IDs stay keyed to the logical repo folder
  const sessionId = deriveSessionId(
    channelId,
    options.sessionFolder ? resolve(options.sessionFolder) : cwd,
    threadTs,
  );

  const { jsonl: sessionFile } = sessionArtifactPaths(sessionId, cwd);
  const resuming = existsSync(sessionFile);

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    '--model',
    model,
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--append-system-prompt',
    prompt,
  ];

  // See note on the batch path: --mcp-config is variadic, so put another flag
  // after it to terminate the variadic.
  const mcpConfigPath = getMcpConfigPath(
    options.credentials?.readOnlyMcpServers ?? [],
    process.cwd(),
  );
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  // See note on the batch path: strict mode keeps the operator's ~/.claude.json
  // MCP servers (and embedded credentials) out of gateway-spawned sessions.
  args.push('--strict-mcp-config');
  args.push('--dangerously-skip-permissions');

  return { args, sessionId, cwd, resuming };
}

function createPersistentProcess(
  options: ClaudeOptions,
  timeoutMs: number,
  regKey: string,
): PersistentProcessEntry {
  const { args, sessionId, cwd, resuming } = buildPersistentClaudeArgs(options);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} persistent session ${sessionId} [${permissionKeyStr(options.userPermissions) || 'read-only'}]`,
  );

  // Build injected vars specific to persistent mode
  const injected = buildInjectedEnv(options);
  injected.CLAUDEWAY_CHANNEL_ID = options.channelId;
  if (options.tempBaseDir) {
    injected.CLAUDEWAY_TEMP_BASE = options.tempBaseDir;
  }

  // Build complete env via allowlist
  const env = buildAllowedEnv({
    config: options.config,
    userPermissions: options.userPermissions,
    extraEnv: injected,
    userCredEnv: options.credentials?.env,
  });

  const proc = spawnTrackedClaude(args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const idKey = processIdentityKey(
    options.userId,
    options.userPermissions,
    options.config,
    options.model,
    options.effort ?? '',
    options.credentials?.secretsHash ?? '',
    options.credentials?.readOnlyMcpServers ?? [],
  );

  const entry: PersistentProcessEntry = {
    proc,
    channelId: options.channelId,
    sessionId,
    permissionKey: permissionKeyStr(options.userPermissions),
    identityKey: idKey,
    startedAt: new Date(),
    lastMessage: '',
    messageCount: 0,
    totalCost: 0,
    totalTokens: 0,
    idleTimer: setTimeout(() => {}, 0), // placeholder; reset immediately below
    absoluteTimer: setTimeout(() => {}, 0), // placeholder; set immediately below
    lineBuffer: '',
    stderrBuf: '',
    currentTurn: null,
  };

  function resetIdleTimer() {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      console.log(`[${options.channelId}] Persistent process idle timeout — killing`);
      proc.kill('SIGTERM');
    }, timeoutMs);
  }

  // Start idle timer + the absolute lifetime cap (idle output resets the idle
  // timer forever, so this backstop guarantees the process is eventually recycled).
  resetIdleTimer();
  entry.absoluteTimer = setTimeout(() => {
    console.log(
      `[${options.channelId}] Persistent process absolute timeout (${ABSOLUTE_TIMEOUT_MS / 3600000}h) — killing`,
    );
    proc.kill('SIGTERM');
  }, ABSOLUTE_TIMEOUT_MS);

  proc.stdout!.on('data', (data: Buffer) => {
    resetIdleTimer();
    entry.lineBuffer += data.toString();
    const lines = entry.lineBuffer.split('\n');
    entry.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      processPersistentLine(entry, line);
    }
  });

  proc.stderr!.on('data', (data: Buffer) => {
    resetIdleTimer();
    // Scrub secret values BEFORE buffering/logging — the buffer feeds error replies
    const text = scrub(data.toString(), options.credentials?.secretValues);
    // Keep the tail so the close handler can include the current turn's stderr
    entry.stderrBuf = (entry.stderrBuf + text).slice(-2048);
    console.error(`[${options.channelId}] Persistent stderr: ${text.trim()}`);
  });

  proc.on('close', (code) => {
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.absoluteTimer);
    persistentRegistry.delete(regKey);

    // Process remaining buffered line
    if (entry.lineBuffer.trim()) {
      processPersistentLine(entry, entry.lineBuffer);
      entry.lineBuffer = '';
    }

    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      if (code !== 0) {
        const stderrPart = entry.stderrBuf.trim() ? `: ${entry.stderrBuf.trim()}` : '';
        turn.reject(new Error(`Persistent Claude process exited with code ${code}${stderrPart}`));
      } else {
        // Process ended cleanly mid-turn — resolve with what we have
        turn.resolve({
          response: turn.fullText,
          sessionId: turn.sessionId,
          cost: turn.cost,
          tokens: null,
        });
      }
    }
  });

  proc.on('error', (err) => {
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.absoluteTimer);
    persistentRegistry.delete(regKey);
    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      turn.reject(new Error(`Failed to spawn persistent claude: ${err.message}`));
    }
  });

  persistentRegistry.set(regKey, entry);
  return entry;
}

function processPersistentLine(entry: PersistentProcessEntry, line: string): void {
  const event = parseStreamLine(line);
  if (!event) return;

  if (event.type === 'user_receipt') {
    console.log(`[${entry.channelId}] Persistent: user message receipt`);
    return;
  }

  if (event.type === 'text_delta' && entry.currentTurn) {
    entry.currentTurn.fullText += event.text;
    entry.currentTurn.onTextDelta?.(event.text);
    return;
  }

  if (event.type === 'reasoning_delta' && entry.currentTurn) {
    entry.currentTurn.onReasoningDelta?.(event.text);
    return;
  }

  if (event.type === 'tool_start' && entry.currentTurn) {
    entry.currentTurn.toolAccums.start(event.toolName, event.index);
    void entry.currentTurn.onToolEvent?.({
      phase: 'start',
      toolName: event.toolName,
      index: event.index,
    });
    return;
  }

  if (event.type === 'tool_input_delta' && entry.currentTurn) {
    entry.currentTurn.toolAccums.appendInput(event.index, event.partialJson);
    return;
  }

  if (event.type === 'tool_stop' && entry.currentTurn) {
    const acc = entry.currentTurn.toolAccums.stop(event.index);
    if (acc) {
      const { toolName, partialJson, index } = acc;
      const keyArg = extractKeyArg(toolName, partialJson);
      void entry.currentTurn.onToolEvent?.({ phase: 'complete', toolName, keyArg, index });
    }
    return;
  }

  if (event.type === 'subagent_progress' && entry.currentTurn) {
    void entry.currentTurn.onToolEvent?.({
      phase: 'subagent_progress',
      toolName: event.toolName,
      description: event.description,
    });
    return;
  }

  if (event.type === 'subagent_completed' && entry.currentTurn) {
    void entry.currentTurn.onToolEvent?.({
      phase: 'subagent_completed',
      toolName: 'Agent',
      description: event.description,
      usage: event.usage,
    });
    return;
  }

  if (event.type === 'result' && entry.currentTurn) {
    entry.messageCount++;
    entry.totalCost += event.cost ?? 0;
    entry.totalTokens += event.tokens ?? 0;
    const turn = entry.currentTurn;
    entry.currentTurn = null;
    turn.resolve({
      response: event.text || turn.fullText,
      sessionId: event.sessionId ?? turn.sessionId,
      cost: event.cost ?? turn.cost,
      tokens: event.tokens,
    });
  }
}

/**
 * Kill a persistent process and wait for it to exit.
 * Sends SIGTERM, waits up to 5s, then escalates to SIGKILL.
 */
async function killAndWait(entry: PersistentProcessEntry): Promise<void> {
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.absoluteTimer);
  return new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        // Process may already be gone
      }
    }, 5000);

    entry.proc.once('close', () => {
      clearTimeout(killTimer);
      resolve();
    });

    try {
      entry.proc.kill('SIGTERM');
    } catch {
      // Process may already be gone
      clearTimeout(killTimer);
      resolve();
    }
  });
}

export async function runClaudePersistentStreaming(
  options: ClaudeStreamingOptions,
): Promise<ClaudeResult> {
  const { channelId, message, timeoutMs, filePaths, onTextDelta } = options;
  const regKey = registryKey(channelId, options.threadTs);

  let entry = persistentRegistry.get(regKey);

  // Kill and respawn if user identity, permissions, or env exposure changed
  const incomingIdentityKey = processIdentityKey(
    options.userId,
    options.userPermissions,
    options.config,
    options.model,
    options.effort ?? '',
    options.credentials?.secretsHash ?? '',
    options.credentials?.readOnlyMcpServers ?? [],
  );
  if (entry && !entry.proc.killed && entry.identityKey !== incomingIdentityKey) {
    console.log(`[${channelId}] Process identity changed — respawning persistent process`);
    // Clear currentTurn before killing to prevent the close handler from
    // rejecting a stale turn's promise with a spurious error
    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      turn.resolve({
        response: turn.fullText,
        sessionId: turn.sessionId,
        cost: turn.cost,
        tokens: null,
      });
    }
    await killAndWait(entry);
    persistentRegistry.delete(regKey);
    entry = undefined;
  }

  // Spawn or re-spawn if process is gone
  if (!entry || !entry.proc.pid || entry.proc.killed) {
    entry = createPersistentProcess(options, timeoutMs, regKey);
  }

  entry.lastMessage = message.substring(0, 80);

  const content = buildMessageWithFiles(message, filePaths);

  // Write the user message to stdin as NDJSON
  const inputLine = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';

  return new Promise((resolve, reject) => {
    if (!entry) {
      reject(new Error('Persistent process entry missing'));
      return;
    }

    // Single-slot turn guard: the engine serializes per channel (channelBusy),
    // so an occupied slot means that serialization was defeated somewhere.
    // Overwriting would orphan the running turn's promise forever (frozen
    // stream, leaked process slot) — surface the bug loudly instead.
    if (entry.currentTurn) {
      reject(
        new Error(
          `A turn is already in progress for ${regKey} — refusing to overwrite it. This indicates a serialization bug.`,
        ),
      );
      return;
    }

    entry.stderrBuf = '';
    entry.currentTurn = {
      resolve,
      reject,
      onTextDelta,
      onReasoningDelta: options.onReasoningDelta,
      onToolEvent: options.onToolEvent,
      fullText: '',
      sessionId: entry.sessionId,
      cost: null,
      toolAccums: new ToolUseAccumulators(),
    };

    // Provide kill callback for cancellation
    options.onProcessSpawned?.(() => {
      try {
        entry!.proc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    });

    entry.proc.stdin!.write(inputLine, (err) => {
      if (err) {
        if (entry!.currentTurn) {
          entry!.currentTurn = null;
        }
        reject(new Error(`Failed to write to persistent claude stdin: ${err.message}`));
      }
    });
  });
}
