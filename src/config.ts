import { readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

export type ResponseMode = 'batch' | 'stream-update' | 'stream-native';
export type ProcessMode = 'oneshot' | 'persistent';
export type TriggerMode = 'all' | 'mention';

export interface RepoConfig {
  url: string;
  branch?: string;
}

export interface ChannelConfig {
  name: string;
  repo?: string;
  folder?: string;
  additionalRepos?: string[];
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
  processMode?: ProcessMode;
  allowedUsers?: string[];
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

export interface Config {
  repos?: Record<string, RepoConfig>;
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
  botOwner?: string;
}

export function getConfigPath(): string {
  return resolve(process.cwd(), 'config.yaml');
}

const DEFAULT_TEMP_DIR = '.claudeway-tmp';

export function resolvedTempDir(config: Config): string {
  return resolve(process.cwd(), config.defaults.tempDir ?? DEFAULT_TEMP_DIR);
}

export function resolveFolder(folder: string): string {
  return resolve(process.cwd(), '.repos', folder);
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
      if (ch.additionalRepos) {
        for (const name of ch.additionalRepos) {
          if (!(name in config.repos)) {
            throw new Error(
              `${configPath}: channel ${channelId} references unknown repo "${name}"`,
            );
          }
        }
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
