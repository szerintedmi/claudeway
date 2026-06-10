import { spawn, type ChildProcess } from 'child_process';
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

// Re-export ProcessMode for consumers that only import from claude.ts
export type { ProcessMode } from './config.js';

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
  userId: string;
  userName?: string;
  channelName?: string;
  scratchDir?: string;
}

export interface ClaudeStreamingOptions extends ClaudeOptions {
  onTextDelta: (text: string) => void;
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
  lineBuffer: string;
  /** Stderr of the current turn (bounded; reset when a new turn is written to stdin) */
  stderrBuf: string;
  currentTurn: {
    resolve: (r: ClaudeResult) => void;
    reject: (e: Error) => void;
    onTextDelta?: (text: string) => void;
    onToolEvent?: (event: ToolEventPayload) => void;
    fullText: string;
    sessionId: string | null;
    cost: number | null;
    toolAccum: ToolAccumulator | null;
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

// --- Stream-json line parser (pure, exported for testing) ---

export type ToolEventPayload =
  | { phase: 'start'; toolName: string }
  | { phase: 'complete'; toolName: string; keyArg: string | null }
  | { phase: 'subagent_progress'; toolName: string; description: string }
  | {
      phase: 'subagent_completed';
      toolName: string;
      description: string;
      usage?: { toolUses: number; tokens: number; durationMs: number };
    };

export type StreamLineEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'result';
      text: string;
      sessionId: string | null;
      cost: number | null;
      tokens: number | null;
    }
  | { type: 'user_receipt' }
  | { type: 'tool_start'; toolName: string; index: number }
  | { type: 'tool_input_delta'; partialJson: string; index: number }
  | { type: 'tool_stop'; index: number }
  | { type: 'subagent_progress'; description: string; toolName: string }
  | {
      type: 'subagent_completed';
      description: string;
      usage?: { toolUses: number; tokens: number; durationMs: number };
    }
  | null;

/**
 * Parse one NDJSON line from Claude CLI --output-format stream-json output.
 * Returns a typed event or null (unrecognised / whitespace / invalid JSON).
 */
export function parseStreamLine(line: string): StreamLineEvent {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);

    // Text delta — {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      obj.event.delta.text
    ) {
      return { type: 'text_delta', text: obj.event.delta.text };
    }

    // Result event
    if (obj.type === 'result') {
      const usage = obj.usage;
      const tokens = usage != null ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null;
      return {
        type: 'result',
        text: obj.result ?? '',
        sessionId: obj.session_id ?? null,
        cost: obj.cost_usd ?? obj.total_cost_usd ?? null,
        tokens,
      };
    }

    // User message receipt (persistent mode --replay-user-messages)
    if (obj.type === 'user') {
      return { type: 'user_receipt' };
    }

    // Tool use start — content_block_start with tool_use type
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_start' &&
      obj.event.content_block?.type === 'tool_use'
    ) {
      return {
        type: 'tool_start',
        toolName: obj.event.content_block.name ?? 'unknown',
        index: obj.event.index ?? -1,
      };
    }

    // Tool input delta — partial JSON for tool arguments
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'input_json_delta'
    ) {
      return {
        type: 'tool_input_delta',
        partialJson: obj.event.delta.partial_json ?? '',
        index: obj.event.index ?? -1,
      };
    }

    // Content block stop — only meaningful when matched with a tool block by index
    if (obj.type === 'stream_event' && obj.event?.type === 'content_block_stop') {
      return { type: 'tool_stop', index: obj.event.index ?? -1 };
    }

    // Sub-agent progress: system events with task_progress subtype
    if (obj.type === 'system' && obj.subtype === 'task_progress' && obj.description) {
      return {
        type: 'subagent_progress',
        description: obj.description,
        toolName: obj.last_tool_name ?? 'unknown',
      };
    }

    // Sub-agent completed
    if (
      obj.type === 'system' &&
      obj.subtype === 'task_notification' &&
      obj.status === 'completed'
    ) {
      const usage = obj.usage;
      return {
        type: 'subagent_completed',
        description: obj.summary ?? obj.description ?? '',
        ...(usage
          ? {
              usage: {
                toolUses: usage.tool_uses ?? 0,
                tokens: usage.total_tokens ?? 0,
                durationMs: usage.duration_ms ?? 0,
              },
            }
          : {}),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Known tool parameter priority map for extracting the most relevant argument
const TOOL_KEY_PARAMS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  LS: ['path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description'],
};

function extractKeyArg(toolName: string, accumulatedJson: string): string | null {
  try {
    const parsed = JSON.parse(accumulatedJson);
    const priority = TOOL_KEY_PARAMS[toolName] ?? [];
    for (const key of priority) {
      if (typeof parsed[key] === 'string' && parsed[key].length > 0) {
        const val: string = parsed[key];
        return val.length > 80 ? val.substring(0, 77) + '...' : val;
      }
    }
    // Fallback: first string-valued key
    for (const val of Object.values(parsed)) {
      if (typeof val === 'string' && val.length > 0) {
        return (val as string).length > 80
          ? (val as string).substring(0, 77) + '...'
          : (val as string);
      }
    }
  } catch {
    // Partial JSON may not be valid — return null gracefully
  }
  return null;
}

interface ToolAccumulator {
  toolName: string;
  partialJson: string;
  index: number;
}

/** Env vars that disable all git authentication — hard enforcement for read-only users. */
function buildGitReadOnlyEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: '/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    SSH_AUTH_SOCK: '',
    SSH_AGENT_PID: '',
  };
}

// TODO: Parameterize email domain when adding non-Slack adapters (currently hardcoded .slack)
/** Env vars that set git author/committer identity from user profile. */
function buildGitAuthorEnv(userName: string, channelName: string): Record<string, string> {
  const email = `${userName.toLowerCase().replace(/\s+/g, '.')}@${channelName}.slack`;
  return {
    GIT_AUTHOR_NAME: userName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: userName,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** Build all permission-related env vars for a Claude subprocess. */
function buildPermissionsEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // Git author identity for all users with a resolved name
  if (options.userName && options.channelName) {
    Object.assign(env, buildGitAuthorEnv(options.userName, options.channelName));
  }

  // Git credential stripping for users without git permission
  if (options.userPermissions && !options.userPermissions.has('git')) {
    Object.assign(env, buildGitReadOnlyEnv());
  }

  // Scratch directory
  if (options.scratchDir) {
    env.CLAUDEWAY_SCRATCH_DIR = options.scratchDir;
  }

  return env;
}

/** Env vars always passed through to Claude subprocess (safe, non-secret). */
const BASELINE_ENV_VARS = new Set([
  'HOME',
  'USER',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'NODE_PATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

interface AllowedEnvContext {
  config: Config;
  channelId: string;
  userPermissions: UserPermissions;
  /** Explicitly injected vars (git author, git read-only, scratch/temp dirs) */
  extraEnv?: Record<string, string>;
}

/**
 * Build the complete env for a Claude subprocess using an allowlist approach.
 * Only baseline vars + global env + permission-linked env + injected vars are included.
 */
export function buildAllowedEnv(ctx: AllowedEnvContext): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Baseline vars from process.env
  for (const key of BASELINE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // 2. Global env vars
  for (const varName of ctx.config.env ?? []) {
    if (process.env[varName]) env[varName] = process.env[varName]!;
  }

  // 3. Permission-linked env vars
  for (const permName of ctx.userPermissions) {
    for (const varName of ctx.config.permissions?.[permName]?.env ?? []) {
      if (process.env[varName]) env[varName] = process.env[varName]!;
    }
  }

  // 4. Explicit injected vars (git author, git read-only enforcement, CLAUDEWAY_* spawn vars)
  if (ctx.extraEnv) Object.assign(env, ctx.extraEnv);

  // 5. HOME fallback
  if (!env.HOME && env.USER) env.HOME = `/Users/${env.USER}`;

  return env;
}

/**
 * Compute the resolved env var names that would be exposed to Claude,
 * without including secret values. Used for restart key comparison.
 */
function resolveExposedEnvVarNames(
  config: Config,
  _channelId: string,
  permissions: UserPermissions,
): string[] {
  const vars = new Set<string>();

  // Global env
  for (const v of config.env ?? []) vars.add(v);

  // Permission-linked env
  for (const permName of permissions) {
    for (const v of config.permissions?.[permName]?.env ?? []) vars.add(v);
  }

  return [...vars].sort();
}

/**
 * Compute a composite identity key for persistent process restart comparison.
 * Includes user identity, permissions, and resolved env var names.
 */
export function processIdentityKey(
  userId: string,
  permissions: UserPermissions,
  config: Config,
  channelId: string,
  model: string,
): string {
  const permPart = permissionKeyStr(permissions);
  const envPart = resolveExposedEnvVarNames(config, channelId, permissions).join(',');
  return `${userId}|${permPart}|${envPart}|${model}`;
}

function spawnClaudeProcess(args: string[], cwd: string, env: Record<string, string>) {
  return spawn('claude', args, {
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

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      resetTimer();
    });

    proc.stderr.on('data', (data: Buffer) => {
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
        reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
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
    let toolAccum: ToolAccumulator | null = null;

    function processLine(line: string) {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.type === 'text_delta') {
        fullText += event.text;
        onTextDelta(event.text);
      } else if (event.type === 'result') {
        sessionId = event.sessionId ?? sessionId;
        cost = event.cost ?? cost;
        tokens = event.tokens ?? tokens;
        if (event.text) fullText = event.text;
      } else if (event.type === 'tool_start') {
        toolAccum = { toolName: event.toolName, partialJson: '', index: event.index };
        void onToolEvent?.({ phase: 'start', toolName: event.toolName });
      } else if (
        event.type === 'tool_input_delta' &&
        toolAccum &&
        event.index === toolAccum.index
      ) {
        toolAccum.partialJson += event.partialJson;
      } else if (event.type === 'tool_stop' && toolAccum && event.index === toolAccum.index) {
        const keyArg = extractKeyArg(toolAccum.toolName, toolAccum.partialJson);
        void onToolEvent?.({ phase: 'complete', toolName: toolAccum.toolName, keyArg });
        toolAccum = null;
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
    proc.stdout.on('data', (data: Buffer) => {
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

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[claude-stderr] ${chunk.trimEnd()}`);
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
        reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      if (!fullText) {
        const details: string[] = [];
        if (stderr) details.push(`stderr: ${stderr.trimEnd().slice(-500)}`);
        if (rawStdout) details.push(`stdout(last 500): ${rawStdout.trimEnd().slice(-500)}`);
        const detail = details.length > 0 ? ` ${details.join(' | ')}` : '';
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
  const home = process.env.HOME ?? `/Users/${process.env.USER ?? ''}`;
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
  const sessionId = deriveSessionId(channelId, cwd, threadTs);

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
  const mcpConfigPath = getMcpConfigPath(options.userPermissions, process.cwd());
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  args.push('--dangerously-skip-permissions');

  args.push(buildMessageWithFiles(message, options.filePaths));

  return { args, sessionId, cwd, resuming };
}

function makeFreshArgs(args: string[], sessionId: string): string[] {
  return args.map((a, i) => (a === '--resume' && args[i + 1] === sessionId ? '--session-id' : a));
}

/**
 * Build injected env vars (temp dirs, permissions) — these go through extraEnv,
 * not from process.env passthrough.
 */
function buildInjectedEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};

  if (options.tempDir) {
    env.CLAUDEWAY_TEMP_DIR = options.tempDir;
    env.CLAUDEWAY_CHANNEL_ID = options.channelId;
  }

  Object.assign(env, buildPermissionsEnv(options));

  return env;
}

/**
 * Build the complete env for a Claude subprocess using the allowlist approach.
 * Only baseline vars + configured secret groups + explicit injected vars are included.
 */
function buildSpawnEnv(options: ClaudeOptions): Record<string, string> {
  return buildAllowedEnv({
    config: options.config,
    channelId: options.channelId,
    userPermissions: options.userPermissions,
    extraEnv: buildInjectedEnv(options),
  });
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'json');
  const spawnEnv = buildSpawnEnv(options);
  const regKey = registryKey(options.channelId, options.threadTs);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} session ${sessionId} [${permissionKeyStr(options.userPermissions) || 'read-only'}]`,
  );

  try {
    return await runClaudeProcess(
      args,
      cwd,
      options.timeoutMs,
      options.channelId,
      sessionId,
      options.message,
      regKey,
      spawnEnv,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${options.channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await runClaudeProcess(
        makeFreshArgs(args, sessionId),
        cwd,
        options.timeoutMs,
        options.channelId,
        sessionId,
        options.message,
        regKey,
        spawnEnv,
      );
    }
    throw err;
  }
}

export async function runClaudeStreaming(options: ClaudeStreamingOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'stream-json');
  const spawnEnv = buildSpawnEnv(options);
  const regKey = registryKey(options.channelId, options.threadTs);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} streaming session ${sessionId} [${permissionKeyStr(options.userPermissions) || 'read-only'}]`,
  );

  try {
    return await runClaudeStreamingProcess(
      args,
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
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${options.channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await runClaudeStreamingProcess(
        makeFreshArgs(args, sessionId),
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
      );
    }
    throw err;
  }
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
  const sessionId = deriveSessionId(channelId, cwd, threadTs);

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
  const mcpConfigPath = getMcpConfigPath(options.userPermissions, process.cwd());
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
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
    channelId: options.channelId,
    userPermissions: options.userPermissions,
    extraEnv: injected,
  });

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const idKey = processIdentityKey(
    options.userId,
    options.userPermissions,
    options.config,
    options.channelId,
    options.model,
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

  // Start idle timer
  resetIdleTimer();

  proc.stdout.on('data', (data: Buffer) => {
    resetIdleTimer();
    entry.lineBuffer += data.toString();
    const lines = entry.lineBuffer.split('\n');
    entry.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      processPersistentLine(entry, line);
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    resetIdleTimer();
    const text = data.toString();
    // Keep the tail so the close handler can include the current turn's stderr
    entry.stderrBuf = (entry.stderrBuf + text).slice(-2048);
    console.error(`[${options.channelId}] Persistent stderr: ${text.trim()}`);
  });

  proc.on('close', (code) => {
    clearTimeout(entry.idleTimer);
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

  if (event.type === 'tool_start' && entry.currentTurn) {
    entry.currentTurn.toolAccum = { toolName: event.toolName, partialJson: '', index: event.index };
    void entry.currentTurn.onToolEvent?.({ phase: 'start', toolName: event.toolName });
    return;
  }

  if (
    event.type === 'tool_input_delta' &&
    entry.currentTurn?.toolAccum &&
    event.index === entry.currentTurn.toolAccum.index
  ) {
    entry.currentTurn.toolAccum.partialJson += event.partialJson;
    return;
  }

  if (
    event.type === 'tool_stop' &&
    entry.currentTurn?.toolAccum &&
    event.index === entry.currentTurn.toolAccum.index
  ) {
    const { toolName, partialJson } = entry.currentTurn.toolAccum;
    const keyArg = extractKeyArg(toolName, partialJson);
    void entry.currentTurn.onToolEvent?.({ phase: 'complete', toolName, keyArg });
    entry.currentTurn.toolAccum = null;
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
    channelId,
    options.model,
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

    entry.stderrBuf = '';
    entry.currentTurn = {
      resolve,
      reject,
      onTextDelta,
      onToolEvent: options.onToolEvent,
      fullText: '',
      sessionId: entry.sessionId,
      cost: null,
      toolAccum: null,
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
