import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolvedChannelConfig,
  getChannelConfig,
  loadConfig,
  saveConfig,
  type Config,
} from '../config.js';

const baseConfig: Config = {
  channels: {
    C001: { name: 'test-channel', folder: '/projects/test' },
    C002: {
      name: 'custom-channel',
      folder: '/projects/custom',
      model: 'sonnet',
      systemPrompt: 'custom prompt',
      timeoutMs: 60_000,
      responseMode: 'stream-update',
      processMode: 'persistent',
    },
  },
  defaults: {
    model: 'opus',
    systemPrompt: 'default prompt',
    timeoutMs: 300_000,
    responseMode: 'batch',
    processMode: 'oneshot',
  },
};

describe('resolvedChannelConfig', () => {
  it('returns null for an unknown channelId', () => {
    expect(resolvedChannelConfig(baseConfig, 'C999')).toBeNull();
  });

  it('fills in all defaults when channel has only name and folder', () => {
    const result = resolvedChannelConfig(baseConfig, 'C001');
    expect(result).toMatchObject({
      name: 'test-channel',
      folder: '/projects/test',
      model: 'opus',
      systemPrompt: 'default prompt',
      timeoutMs: 300_000,
      responseMode: 'batch',
      processMode: 'oneshot',
    });
  });

  it('uses channel-level overrides over defaults', () => {
    const result = resolvedChannelConfig(baseConfig, 'C002');
    expect(result).toMatchObject({
      model: 'sonnet',
      systemPrompt: 'custom prompt',
      timeoutMs: 60_000,
      responseMode: 'stream-update',
      processMode: 'persistent',
    });
  });

  it('defaults processMode to "oneshot" when absent from both channel and defaults', () => {
    const config: Config = {
      channels: { C003: { name: 'x', folder: '/x' } },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    expect(resolvedChannelConfig(config, 'C003')?.processMode).toBe('oneshot');
  });

  it('channel-level responseMode overrides defaults', () => {
    const config: Config = {
      ...baseConfig,
      channels: {
        C004: { name: 'y', folder: '/y', responseMode: 'stream-native' },
      },
    };
    expect(resolvedChannelConfig(config, 'C004')?.responseMode).toBe('stream-native');
  });

  it('preserves allowedUsers in resolved config', () => {
    const config: Config = {
      channels: {
        C005: { name: 'restricted', folder: '/r', allowedUsers: ['U111', 'U222'] },
      },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    const result = resolvedChannelConfig(config, 'C005');
    expect(result?.allowedUsers).toEqual(['U111', 'U222']);
  });

  it('returns undefined allowedUsers when not set', () => {
    const result = resolvedChannelConfig(baseConfig, 'C001');
    expect(result?.allowedUsers).toBeUndefined();
  });
});

describe('getChannelConfig', () => {
  it('returns the channel config for a known channel', () => {
    expect(getChannelConfig(baseConfig, 'C001')).toEqual(baseConfig.channels['C001']);
  });

  it('returns null for an unknown channel', () => {
    expect(getChannelConfig(baseConfig, 'C999')).toBeNull();
  });
});

describe('config file support', () => {
  let tmpDir: string;
  const originalCwd = process.cwd;

  const minimalYaml = `
channels:
  C002:
    name: from-yaml
    folder: /yaml
defaults:
  model: opus
  systemPrompt: yaml prompt
  timeoutMs: 300000
  responseMode: batch
`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeway-config-test-'));
    process.cwd = () => tmpDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config.yaml', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), minimalYaml);
    const config = loadConfig();
    expect(config.channels.C002.name).toBe('from-yaml');
  });

  it('saveConfig writes YAML', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), minimalYaml);
    const config = loadConfig();
    config.channels.C002.name = 'updated';
    saveConfig(config);

    const saved = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(saved).toContain('updated');
  });

  it('applies defaults when loading config', () => {
    const yamlNoDefaults = `
channels:
  C001:
    name: minimal
    folder: /min
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yamlNoDefaults);
    const config = loadConfig();
    expect(config.defaults.responseMode).toBe('batch');
    expect(config.defaults.processMode).toBe('oneshot');
  });
});
