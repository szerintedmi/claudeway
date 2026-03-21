import { readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

/** Root directory for persistent state (repos, queue, files). */
export const DATA_DIR = resolve(process.cwd(), '.docker');

export type ResponseMode = 'batch' | 'stream-update' | 'stream-native';
export type ProcessMode = 'oneshot' | 'persistent';
export type TriggerMode = 'all' | 'mention';

export interface RepoConfig {
  url: string;
  branch?: string;
}

export type AllowedUserEntry = string | Record<string, string[]>;

export interface UserPermissions {
  git: boolean;
  jiraWrite: boolean;
}

export const FULL_PERMISSIONS: UserPermissions = { git: true, jiraWrite: true };
export const READ_ONLY_PERMISSIONS: UserPermissions = { git: false, jiraWrite: false };

const VALID_PERMISSIONS = new Set(['git', 'jiraWrite']);

/**
 * Parse mixed allowedUsers entries into a map of userId → permissions.
 * Plain string entries get read-only permissions. Object entries get the listed permissions.
 */
export function parseAllowedUsers(entries: AllowedUserEntry[]): Map<string, UserPermissions> {
  const map = new Map<string, UserPermissions>();
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map.set(entry, { ...READ_ONLY_PERMISSIONS });
    } else {
      for (const [userId, perms] of Object.entries(entry)) {
        map.set(userId, {
          git: perms.includes('git'),
          jiraWrite: perms.includes('jiraWrite'),
        });
      }
    }
  }
  return map;
}

/**
 * Extract just the user IDs from mixed allowedUsers entries.
 */
export function extractAllowedUserIds(entries: AllowedUserEntry[]): string[] {
  return entries.flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.keys(entry)));
}

/**
 * Resolve a user's permissions for a given channel.
 * botOwner always gets full permissions. Users not in allowedUsers get read-only.
 */
export function resolveUserPermissions(
  config: Config,
  channelId: string,
  userId: string,
): UserPermissions {
  const ch = config.channels[channelId];
  if (!ch?.allowedUsers || ch.allowedUsers.length === 0) {
    // No allowedUsers list — botOwner gets full, others read-only
    return userId === config.botOwner ? { ...FULL_PERMISSIONS } : { ...READ_ONLY_PERMISSIONS };
  }

  const parsed = parseAllowedUsers(ch.allowedUsers);
  const explicit = parsed.get(userId);
  if (explicit !== undefined) return explicit;

  // Not listed — botOwner gets full access, others read-only
  return userId === config.botOwner ? { ...FULL_PERMISSIONS } : { ...READ_ONLY_PERMISSIONS };
}

/**
 * Compute a stable string key from permissions for comparison.
 * Undefined permissions are treated as full access.
 */
export function permissionKey(p: UserPermissions | undefined): string {
  if (!p) return 'git,jiraWrite';
  const parts: string[] = [];
  if (p.git) parts.push('git');
  if (p.jiraWrite) parts.push('jiraWrite');
  return parts.join(',');
}

export interface ChannelConfig {
  name: string;
  repo?: string;
  folder?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
  processMode?: ProcessMode;
  allowedUsers?: AllowedUserEntry[];
  triggerMode?: TriggerMode;
}

export interface Defaults {
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode?: ProcessMode;
  triggerMode?: TriggerMode;
  tempDir?: string;
}

export interface GlassesTokenConfig {
  token: string;
  userId: string;
  defaultChannel: string;
}

export interface GlassesServerConfig {
  enabled: boolean;
  port: number;
  auth: { tokens: GlassesTokenConfig[] };
}

export interface DeepgramConfig {
  apiKey: string;
  sttModel?: string; // defaults to 'nova-3'
  ttsModel?: string; // defaults to 'aura-2-thalia-en'
  ttsVoice?: string; // unused for now — voice embedded in model name
  ttsSampleRate?: number; // defaults to 24000
}

export interface VoiceConfig {
  provider: 'deepgram';
  deepgram: DeepgramConfig;
}

export interface Config {
  repos?: Record<string, RepoConfig>;
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
  botOwner?: string;
  glassesServer?: GlassesServerConfig;
  voice?: VoiceConfig;
}

export function getConfigPath(): string {
  return resolve(process.cwd(), 'config.yaml');
}

const DEFAULT_TEMP_DIR = '.claudeway-tmp';

export function resolvedTempDir(config: Config): string {
  return resolve(process.cwd(), config.defaults.tempDir ?? DEFAULT_TEMP_DIR);
}

export function resolveFolder(folder: string): string {
  return resolve(DATA_DIR, 'repos', folder);
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  const raw = readFileSync(configPath, 'utf-8');
  const config = yamlParse(raw) as Config;

  if (!config.channels || typeof config.channels !== 'object') {
    throw new Error(`${configPath}: "channels" must be an object`);
  }
  if (!config.defaults) {
    config.defaults = {
      model: 'opus',
      systemPrompt:
        'Format all responses using Slack mrkdwn syntax (NOT standard Markdown). Key rules: *bold* (single asterisk), _italic_ (underscore), ~strikethrough~ (single tilde), `code`, ```code blocks``` (no language tag), > blockquote, <URL|label> for links (NOT [label](url)), :emoji: shortcodes. Standard Markdown ##headers, **bold**, [links](url), and tables do NOT work in Slack. Use - or numbered lists. Keep responses concise.',
      timeoutMs: 300000,
      responseMode: 'batch',
    };
  }
  if (!config.defaults.responseMode) {
    config.defaults.responseMode = 'batch';
  }
  if (!config.defaults.processMode) {
    config.defaults.processMode = 'oneshot';
  }

  // Validate permission strings in allowedUsers
  for (const [chId, ch] of Object.entries(config.channels)) {
    if (ch.allowedUsers) {
      for (const entry of ch.allowedUsers) {
        if (typeof entry === 'object') {
          for (const [, perms] of Object.entries(entry)) {
            for (const perm of perms) {
              if (!VALID_PERMISSIONS.has(perm)) {
                throw new Error(
                  `${configPath}: channel ${chId} has unknown permission "${perm}". Valid: ${[...VALID_PERMISSIONS].join(', ')}`,
                );
              }
            }
          }
        }
      }
    }
  }

  // Validate voice config if present
  if (config.voice) {
    if (config.voice.provider !== 'deepgram') {
      throw new Error(`${configPath}: voice.provider must be "deepgram"`);
    }
    if (!config.voice.deepgram?.apiKey) {
      throw new Error(`${configPath}: voice.deepgram.apiKey is required`);
    }
    const resolvedKey = interpolateEnvVars(config.voice.deepgram.apiKey);
    if (!resolvedKey) {
      throw new Error(
        `${configPath}: voice.deepgram.apiKey resolves to empty — set the environment variable`,
      );
    }
  }

  // Validate repo references
  if (config.repos) {
    for (const [channelId, ch] of Object.entries(config.channels)) {
      const repoName = ch.repo ?? ch.folder;
      if (!repoName) {
        throw new Error(`${configPath}: channel ${channelId} must have a "repo" field`);
      }
      if (!(repoName in config.repos)) {
        throw new Error(
          `${configPath}: channel ${channelId} repo "${repoName}" is not defined in repos`,
        );
      }
    }
  }

  return config;
}

export function saveConfig(config: Config): void {
  const configPath = getConfigPath();
  const content = yamlStringify(config, { lineWidth: 0 });
  const tmpPath = configPath + '.tmp';

  // Write to temp file
  writeFileSync(tmpPath, content, 'utf-8');

  // Validate the temp file parses correctly and has required fields
  const parsed = yamlParse(readFileSync(tmpPath, 'utf-8')) as Config;
  if (!parsed.channels || typeof parsed.channels !== 'object') {
    throw new Error('saveConfig: validation failed — "channels" must be an object');
  }

  // Atomic rename: temp → original
  renameSync(tmpPath, configPath);
}

export function resolvedDmConfig(config: Config) {
  return {
    name: 'dm',
    folder: '.',
    model: config.defaults.model,
    systemPrompt: config.defaults.systemPrompt,
    timeoutMs: config.defaults.timeoutMs,
    responseMode: config.defaults.responseMode,
    processMode: config.defaults.processMode ?? ('oneshot' as ProcessMode),
    triggerMode: config.defaults.triggerMode ?? ('all' as TriggerMode),
  };
}

export function getChannelConfig(config: Config, channelId: string): ChannelConfig | null {
  return config.channels[channelId] ?? null;
}

export interface ResolvedChannelConfig extends ChannelConfig {
  folder: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode: ProcessMode;
  triggerMode: TriggerMode;
}

export function resolvedChannelConfig(
  config: Config,
  channelId: string,
): ResolvedChannelConfig | null {
  const ch = config.channels[channelId];
  if (!ch) return null;
  const repoOrFolder = ch.repo ?? ch.folder ?? '.';
  const folder = config.repos ? resolveFolder(repoOrFolder) : repoOrFolder;
  return {
    ...ch,
    folder,
    model: ch.model ?? config.defaults.model,
    systemPrompt: ch.systemPrompt ?? config.defaults.systemPrompt,
    timeoutMs: ch.timeoutMs ?? config.defaults.timeoutMs,
    responseMode: ch.responseMode ?? config.defaults.responseMode,
    processMode: ch.processMode ?? config.defaults.processMode ?? 'oneshot',
    triggerMode: ch.triggerMode ?? config.defaults.triggerMode ?? 'all',
  };
}

/**
 * Interpolate env var references like ${VAR_NAME} in a string.
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * Resolve a raw token (possibly with env var interpolation) to its GlassesTokenConfig.
 * Returns null if no matching token is found.
 */
export function resolveGlassesToken(config: Config, rawToken: string): GlassesTokenConfig | null {
  const tokens = config.glassesServer?.auth?.tokens;
  if (!tokens) return null;
  for (const entry of tokens) {
    const resolved = interpolateEnvVars(entry.token);
    if (resolved === rawToken) return entry;
  }
  return null;
}
