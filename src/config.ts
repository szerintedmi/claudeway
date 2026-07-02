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

/**
 * Canonical user registry entry — one per person, referenced by channels.
 * The registry key is the canonical user id used by the secret store,
 * audit log, and persistent-process identity.
 */
export interface UserDef {
  /** Display name (git author identity). Defaults to the registry key. */
  name?: string;
  /** Slack user ID (U...) */
  slack?: string;
  /** Voice adapter user id (matches voiceServer.auth.tokens[].userId) */
  voice?: string;
  /** Permission names from config.permissions */
  permissions?: string[];
}

/** Channel member entry: canonical user id, or { id: [extraPermissions] }. */
export type MemberEntry = string | Record<string, string[]>;

export type CredentialExposeAs = 'env' | 'git-credential-helper';

export interface CredentialFieldDef {
  /** Human-readable field label shown on the enrollment form. */
  label?: string;
  /** Whether the form input should mask this value. Defaults to true. */
  secret?: boolean;
  /** Optional shared default source. This env var name may differ from the exposed field name. */
  defaultFromEnv?: string;
}

export interface CredentialField {
  name: string;
  def: CredentialFieldDef;
}

/**
 * Per-user credential registry entry (config-driven).
 * `fields` names values carried by this credential. Personal values are stored
 * under the field name; `defaultFromEnv` can provide an explicit shared default.
 */
export interface CredentialDef {
  label: string;
  /** Values carried by this credential, keyed by the name exposed to the child/tool. */
  fields: Record<string, CredentialFieldDef>;
  /** How the resolved credential is exposed. Default: env. */
  exposeAs?: CredentialExposeAs;
  /** Least-privilege guidance shown on the enrollment form. */
  guidance?: string;
  /**
   * What the shared default token (defaultFromEnv) can and cannot do, e.g.
   * "read-only — creating or updating Jira issues will fail". Injected into
   * the subprocess system prompt so the agent warns users preemptively
   * instead of attempting a write that fails.
   */
  sharedAccessNote?: string;
}

export interface CredsFormConfig {
  /** HTTP port for the enrollment form server (default 8791). */
  port?: number;
}

/** A user's granted permissions — set of permission names from config.permissions keys. */
export type UserPermissions = Set<string>;

/** Empty permission set (read-only). */
export const READ_ONLY_PERMISSIONS: UserPermissions = new Set<string>();

/** All permissions defined in config. */
export function fullPermissions(config: Config): UserPermissions {
  return new Set(Object.keys(config.permissions ?? {}));
}

export function credentialExposeAs(def: CredentialDef): CredentialExposeAs {
  return def.exposeAs ?? 'env';
}

export function credentialFields(def: CredentialDef): CredentialField[] {
  return Object.entries(def.fields).map(([name, fieldDef]) => ({
    name,
    def: fieldDef ?? {},
  }));
}

export interface PermissionDef {
  env?: string[];
}

/** Bot owner entries as configured — registry keys or raw Slack ids ([] when unset). */
export function botOwnerIds(config: Config): string[] {
  return config.botOwners ?? [];
}

/** Bot owners resolved to Slack user ids — for mentions and DM notifications. */
export function botOwnerSlackIds(config: Config): string[] {
  return botOwnerIds(config)
    .map((entry) => config.users?.[entry]?.slack ?? entry)
    .filter((id) => !!id);
}

/**
 * Whether an external id belongs to a bot owner. The registry unifies a
 * person's identities — a voice turn by an owner is still an owner (canonical
 * id or registered slack id matches a botOwners entry).
 */
export function isBotOwner(config: Config, externalId: string): boolean {
  const owners = botOwnerIds(config);
  if (owners.length === 0) return false;
  if (owners.includes(externalId)) return true;
  const registry = findRegistryUser(config, externalId);
  if (!registry) return false;
  return (
    owners.includes(registry.userId) ||
    (!!registry.def.slack && owners.includes(registry.def.slack))
  );
}

/** Parse channel member entries into canonicalId → extra permissions. */
export function parseMembers(entries: MemberEntry[]): Map<string, UserPermissions> {
  const map = new Map<string, UserPermissions>();
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map.set(entry, new Set());
    } else {
      for (const [id, perms] of Object.entries(entry)) {
        map.set(id, new Set(perms));
      }
    }
  }
  return map;
}

/**
 * Find a user's canonical registry entry by external id (Slack id, voice id)
 * or by canonical id itself. Returns null if not registered.
 */
export function findRegistryUser(
  config: Config,
  externalId: string,
): { userId: string; def: UserDef } | null {
  for (const [userId, def] of Object.entries(config.users ?? {})) {
    if (userId === externalId || def.slack === externalId || def.voice === externalId) {
      return { userId, def };
    }
  }
  return null;
}

/**
 * Resolve an external id (Slack/voice) to the canonical user id.
 * Unregistered users keep their external id as the canonical id (back-compat) —
 * the secret store, audit log, and process identity all key on this value.
 */
export function resolveCanonicalUserId(config: Config, externalId: string): string {
  return findRegistryUser(config, externalId)?.userId ?? externalId;
}

/** A user resolved through the registry for a specific channel. */
export interface ResolvedUser {
  /** Canonical user id (registry key, or external id when unregistered). */
  userId: string;
  /** Display name from the registry (git author identity). */
  name?: string;
  permissions: UserPermissions;
  /** True when the user exists in the `users:` registry. */
  registered: boolean;
  isBotOwner: boolean;
}

/**
 * Resolve a user (by external Slack/voice id) to canonical identity + permissions
 * for a channel. Permissions are additive: registry permissions ∪ channel member
 * extras. botOwner gets full permissions unless explicitly listed (registry
 * entry or channel member).
 */
export function resolveUser(config: Config, channelId: string, externalId: string): ResolvedUser {
  const registry = findRegistryUser(config, externalId);
  const userId = registry?.userId ?? externalId;
  const owner = isBotOwner(config, externalId);
  const ch = config.channels[channelId];

  const perms = new Set<string>(registry?.def.permissions ?? []);
  let explicitlyListed = registry !== null;

  if (ch?.members && ch.members.length > 0) {
    const extra = parseMembers(ch.members).get(userId);
    if (extra) {
      explicitlyListed = true;
      for (const p of extra) perms.add(p);
    }
  }

  if (owner && !explicitlyListed) {
    return {
      userId,
      name: registry?.def.name,
      permissions: fullPermissions(config),
      registered: registry !== null,
      isBotOwner: owner,
    };
  }

  return {
    userId,
    name: registry?.def.name,
    permissions: perms,
    registered: registry !== null,
    isBotOwner: owner,
  };
}

/**
 * Resolve a user's permissions for a given channel.
 * botOwner always gets full permissions unless explicitly listed. Unlisted users get read-only.
 */
export function resolveUserPermissions(
  config: Config,
  channelId: string,
  userId: string,
): UserPermissions {
  return resolveUser(config, channelId, userId).permissions;
}

/**
 * Whether a user (external id) may interact with a channel.
 * Open when `members` does not restrict the channel.
 */
export function isUserAllowedInChannel(
  config: Config,
  channelId: string,
  externalId: string,
): boolean {
  const ch = config.channels[channelId];
  if (!ch?.members || ch.members.length === 0) return true;
  const canonical = resolveCanonicalUserId(config, externalId);
  return parseMembers(ch.members).has(canonical);
}

/** Whether a user is allowed in at least one configured channel (or is a botOwner). */
export function isUserAllowedAnywhere(config: Config, externalId: string): boolean {
  if (isBotOwner(config, externalId)) return true;
  // Registry presence alone is not enough — the user must be admitted to ≥1 channel
  return Object.keys(config.channels).some((chId) =>
    isUserAllowedInChannel(config, chId, externalId),
  );
}

/**
 * Union of a user's permissions across the registry and every channel —
 * used to gate which credential types they may enroll.
 */
export function resolveGlobalPermissions(config: Config, canonicalUserId: string): UserPermissions {
  const registry = config.users?.[canonicalUserId];
  const perms = new Set<string>(registry?.permissions ?? []);
  for (const ch of Object.values(config.channels)) {
    if (ch.members) {
      for (const p of parseMembers(ch.members).get(canonicalUserId) ?? []) perms.add(p);
    }
  }
  if (isBotOwner(config, canonicalUserId)) {
    return fullPermissions(config);
  }
  return perms;
}

/**
 * Compute a stable string key from permissions for comparison/logging.
 * Undefined permissions are treated as full access.
 */
export function permissionKey(p: UserPermissions | undefined): string {
  if (!p) return '*';
  return [...p].sort().join(',');
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface ChannelConfig {
  name: string;
  repo?: string;
  folder?: string;
  model?: string;
  effort?: EffortLevel;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
  processMode?: ProcessMode;
  /** Channel members referencing the `users:` registry by canonical id. */
  members?: MemberEntry[];
  triggerMode?: TriggerMode;
  /**
   * Run each thread/conversation of this repo-backed channel in its own git
   * worktree (isolation + per-thread branches). Default: true. Disable on
   * busy Q&A channels to avoid one worktree per conversation.
   */
  threadWorktrees?: boolean;
  /**
   * When a streamed turn produces intermediate narration (text between tool
   * calls) on top of the final answer, replace the live message with the clean
   * final answer on completion and archive the full working notes as a
   * collapsed snippet. Applies to `stream-native` mode. Defaults to true.
   */
  collapseWorkingNotes?: boolean;
}

export interface Defaults {
  model: string;
  effort?: EffortLevel;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode?: ProcessMode;
  triggerMode?: TriggerMode;
  collapseWorkingNotes?: boolean;
  tempDir?: string;
  tempMaxAgeDays?: number;
  /** Age (days) after which idle per-thread git worktrees are pruned. */
  threadWorktreeMaxAgeDays?: number;
  /** Default for channels' threadWorktrees flag (default: true). */
  threadWorktrees?: boolean;
}

export interface VoiceTokenConfig {
  token: string;
  userId: string;
  defaultChannel: string;
}

export interface VoiceServerConfig {
  enabled: boolean;
  port: number;
  auth: { tokens: VoiceTokenConfig[] };
}

export interface DeepgramConfig {
  apiKey: string;
  sttModel?: string; // defaults to 'nova-3'
  ttsModel?: string; // defaults to 'aura-2-thalia-en' (Deepgram Aura-2)
  ttsVoice?: string; // unused for now — voice embedded in model name
  ttsSampleRate?: number; // defaults to 24000
  // Note: Deepgram's `speed` param is REST-only, not supported on WebSocket streaming
}

export interface VoiceConfig {
  provider: 'deepgram';
  deepgram: DeepgramConfig;
}

export interface Config {
  repos?: Record<string, RepoConfig>;
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
  /** Bot owners — `users:` registry keys (preferred) or raw Slack ids. All get full owner privileges. */
  botOwners?: string[];
  voiceServer?: VoiceServerConfig;
  voice?: VoiceConfig;
  env?: string[];
  permissions?: Record<string, PermissionDef>;
  /** Canonical person registry — one entry per human, keyed by canonical user id. */
  users?: Record<string, UserDef>;
  /** Per-user credential registry (see docs/per-user-credentials.md). */
  userCredentials?: Record<string, CredentialDef>;
  /** Public base URL for the creds enrollment form (e.g. http://192.168.1.10:8791). */
  baseUrl?: string;
  credsForm?: CredsFormConfig;
}

export function getConfigPath(): string {
  return resolve(process.cwd(), 'config.yaml');
}

const DEFAULT_TEMP_DIR = '.claudeway-tmp';
export const DEFAULT_TEMP_MAX_AGE_DAYS = 90;

export function resolvedTempDir(config: Config): string {
  return resolve(process.cwd(), config.defaults.tempDir ?? DEFAULT_TEMP_DIR);
}

export function resolveFolder(folder: string): string {
  return resolve(DATA_DIR, 'repos', folder);
}

/**
 * Built-in BYO-Claude credential: every user — bot owner included — runs on
 * their own enrolled token, so usage is attributed to their own account.
 * Injected into every loaded config; not configurable.
 */
export const CLAUDE_CREDENTIAL: CredentialDef = {
  label: 'Claude Code OAuth token',
  fields: { CLAUDE_CODE_OAUTH_TOKEN: { label: 'Claude Code OAuth token' } },
  guidance: 'Run `claude setup-token` on your own machine and paste the token.',
};

export function loadConfig(): Config {
  const configPath = getConfigPath();
  const raw = readFileSync(configPath, 'utf-8');
  const config = yamlParse(raw) as Config;

  if (!config.channels || typeof config.channels !== 'object') {
    throw new Error(`${configPath}: "channels" must be an object`);
  }
  if ('botOwner' in (config as unknown as Record<string, unknown>)) {
    throw new Error(
      `${configPath}: "botOwner" has been renamed — use "botOwners" (a list of Slack ids)`,
    );
  }
  if (config.botOwners !== undefined) {
    if (!Array.isArray(config.botOwners) || config.botOwners.some((v) => typeof v !== 'string')) {
      throw new Error(
        `${configPath}: "botOwners" must be a list of users registry keys or Slack user ids`,
      );
    }
    for (const entry of config.botOwners) {
      // Registry key, or something that plausibly is a raw Slack user id
      if (!config.users?.[entry] && !/^[UW][A-Z0-9]{4,}$/.test(entry)) {
        console.warn(
          `[config] botOwners entry "${entry}" is neither a users registry key nor a Slack user id — owner privileges will not resolve`,
        );
      }
    }
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

  // Validate effort levels — YAML bypasses the compile-time EffortLevel type, and the
  // CLI silently falls back to its default on an unknown --effort value
  for (const [where, effort] of [
    ['defaults', config.defaults.effort] as const,
    ...Object.entries(config.channels).map(([chId, ch]) => [`channel ${chId}`, ch.effort] as const),
  ]) {
    if (effort !== undefined && !isEffortLevel(effort)) {
      throw new Error(
        `${configPath}: ${where} has unknown effort "${effort}". Valid: ${EFFORT_LEVELS.join(', ')}`,
      );
    }
  }

  // Validate permissions config
  const validPermissions = new Set(Object.keys(config.permissions ?? {}));

  // allowedUsers was removed (2026-07-02) — refuse rather than silently ignore
  for (const [chId, ch] of Object.entries(config.channels)) {
    if ('allowedUsers' in (ch as unknown as Record<string, unknown>)) {
      throw new Error(
        `${configPath}: channel ${chId} uses "allowedUsers", which has been removed — ` +
          'define people in the top-level "users:" registry and reference them via channel "members:"',
      );
    }
  }

  // Validate users registry
  for (const [userId, def] of Object.entries(config.users ?? {})) {
    for (const perm of def.permissions ?? []) {
      if (!validPermissions.has(perm)) {
        throw new Error(
          `${configPath}: user "${userId}" has unknown permission "${perm}". Defined: ${[...validPermissions].join(', ') || '(none)'}`,
        );
      }
    }
  }

  // Validate channel members reference registered users + known permissions
  for (const [chId, ch] of Object.entries(config.channels)) {
    for (const entry of ch.members ?? []) {
      const memberIds = typeof entry === 'string' ? [entry] : Object.keys(entry);
      for (const id of memberIds) {
        if (!config.users?.[id]) {
          throw new Error(`${configPath}: channel ${chId} member "${id}" is not defined in users`);
        }
      }
      if (typeof entry === 'object') {
        for (const perms of Object.values(entry)) {
          for (const perm of perms) {
            if (!validPermissions.has(perm)) {
              throw new Error(
                `${configPath}: channel ${chId} member has unknown permission "${perm}". Defined: ${[...validPermissions].join(', ') || '(none)'}`,
              );
            }
          }
        }
      }
    }
  }

  // Validate userCredentials registry (claude is built-in, not configurable)
  if (config.userCredentials?.claude) {
    throw new Error(
      `${configPath}: userCredentials.claude is built-in (personal Claude token, always required) — remove the entry`,
    );
  }
  for (const [credName, def] of Object.entries(config.userCredentials ?? {})) {
    const rawDef = def as unknown as Record<string, unknown>;
    for (const legacyKey of ['env', 'inject', 'fallback', 'requiresPermission']) {
      if (legacyKey in rawDef) {
        throw new Error(
          `${configPath}: userCredentials.${credName}.${legacyKey} is no longer supported — use fields/defaultFromEnv/exposeAs`,
        );
      }
    }
    if (!def.fields || typeof def.fields !== 'object' || Array.isArray(def.fields)) {
      throw new Error(
        `${configPath}: userCredentials.${credName}.fields must be an object with at least one field`,
      );
    }
    const exposeAs = credentialExposeAs(def);
    if (exposeAs !== 'env' && exposeAs !== 'git-credential-helper') {
      throw new Error(
        `${configPath}: userCredentials.${credName}.exposeAs must be "env" or "git-credential-helper"`,
      );
    }
    const fields = credentialFields(def);
    if (fields.length === 0) {
      throw new Error(
        `${configPath}: userCredentials.${credName}.fields must list at least one field`,
      );
    }
    if (def.sharedAccessNote !== undefined && typeof def.sharedAccessNote !== 'string') {
      throw new Error(
        `${configPath}: userCredentials.${credName}.sharedAccessNote must be a string`,
      );
    }
    if (def.sharedAccessNote && !fields.some(({ def: f }) => f.defaultFromEnv)) {
      console.warn(
        `[config] userCredentials.${credName}.sharedAccessNote is set but no field has defaultFromEnv — the note only applies to shared defaults`,
      );
    }
    for (const { name, def: fieldDef } of fields) {
      if (!name || typeof name !== 'string') {
        throw new Error(`${configPath}: userCredentials.${credName}.fields contains an empty name`);
      }
      if (fieldDef.defaultFromEnv !== undefined && typeof fieldDef.defaultFromEnv !== 'string') {
        throw new Error(
          `${configPath}: userCredentials.${credName}.fields.${name}.defaultFromEnv must be a string`,
        );
      }
    }
  }

  // BYO Claude is always on — inject the built-in credential so every consumer
  // (resolution, enrollment form, !creds) sees it without config plumbing
  config.userCredentials = { claude: CLAUDE_CREDENTIAL, ...(config.userCredentials ?? {}) };

  // Warn about env vars in permissions not present in process.env
  for (const [permName, def] of Object.entries(config.permissions ?? {})) {
    for (const v of def.env ?? []) {
      if (!process.env[v]) {
        console.warn(`[config] permissions.${permName}.env references "${v}" which is not set`);
      }
    }
  }

  // Warn about global env vars not present in process.env
  for (const v of config.env ?? []) {
    if (!process.env[v]) {
      console.warn(`[config] env references "${v}" which is not set`);
    }
  }

  for (const [credName, def] of Object.entries(config.userCredentials ?? {})) {
    for (const { name, def: fieldDef } of credentialFields(def)) {
      if (fieldDef.defaultFromEnv && !process.env[fieldDef.defaultFromEnv]) {
        console.warn(
          `[config] userCredentials.${credName}.fields.${name}.defaultFromEnv references "${fieldDef.defaultFromEnv}" which is not set`,
        );
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
    collapseWorkingNotes: config.defaults.collapseWorkingNotes ?? true,
    threadWorktrees: false, // DMs run in the gateway's own directory — no repo
  };
}

export function getChannelConfig(config: Config, channelId: string): ChannelConfig | null {
  return config.channels[channelId] ?? null;
}

export interface ResolvedChannelConfig extends ChannelConfig {
  folder: string;
  model: string;
  effort?: EffortLevel;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode: ProcessMode;
  triggerMode: TriggerMode;
  collapseWorkingNotes: boolean;
  threadWorktrees: boolean;
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
    effort: ch.effort ?? config.defaults.effort,
    systemPrompt: ch.systemPrompt ?? config.defaults.systemPrompt,
    timeoutMs: ch.timeoutMs ?? config.defaults.timeoutMs,
    responseMode: ch.responseMode ?? config.defaults.responseMode,
    processMode: ch.processMode ?? config.defaults.processMode ?? 'oneshot',
    triggerMode: ch.triggerMode ?? config.defaults.triggerMode ?? 'all',
    collapseWorkingNotes: ch.collapseWorkingNotes ?? config.defaults.collapseWorkingNotes ?? true,
    threadWorktrees: ch.threadWorktrees ?? config.defaults.threadWorktrees ?? true,
  };
}

/**
 * Interpolate env var references like ${VAR_NAME} in a string.
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * Resolve a raw token (possibly with env var interpolation) to its VoiceTokenConfig.
 * Returns null if no matching token is found.
 */
export function resolveVoiceToken(config: Config, rawToken: string): VoiceTokenConfig | null {
  const tokens = config.voiceServer?.auth?.tokens;
  if (!tokens) return null;
  for (const entry of tokens) {
    const resolved = interpolateEnvVars(entry.token);
    if (resolved === rawToken) return entry;
  }
  return null;
}
