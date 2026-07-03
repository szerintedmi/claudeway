import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolvedChannelConfig,
  getChannelConfig,
  loadConfig,
  saveConfig,
  resolveFolder,
  resolveVoiceToken,
  interpolateEnvVars,
  DATA_DIR,
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

  it('preserves members in resolved config', () => {
    const config: Config = {
      channels: {
        C005: { name: 'restricted', folder: '/r', members: ['alice', 'bob'] },
      },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
      users: { alice: {}, bob: {} },
    };
    const result = resolvedChannelConfig(config, 'C005');
    expect(result?.members).toEqual(['alice', 'bob']);
  });

  it('returns undefined members when not set', () => {
    const result = resolvedChannelConfig(baseConfig, 'C001');
    expect(result?.members).toBeUndefined();
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

  it('validates channel repo references repos map', () => {
    const yaml = `
repos:
  my-repo:
    url: https://github.com/org/my-repo.git
channels:
  C001:
    name: test
    repo: nonexistent-repo
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('repo "nonexistent-repo" is not defined in repos');
  });

  it('loads config with valid repos map', () => {
    const yaml = `
repos:
  my-repo:
    url: https://github.com/org/my-repo.git
    branch: main
  other-repo:
    url: https://github.com/org/other-repo.git
channels:
  C001:
    name: test
    repo: my-repo
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig();
    expect(config.repos?.['my-repo']?.url).toBe('https://github.com/org/my-repo.git');
    expect(config.repos?.['my-repo']?.branch).toBe('main');
  });

  it('skips repo validation when repos map is absent', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /some/path
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects an unknown effort level in defaults', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
defaults:
  model: opus
  effort: hgih
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('defaults has unknown effort "hgih"');
  });

  it('rejects an unknown effort level on a channel', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
    effort: turbo
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('channel C001 has unknown effort "turbo"');
  });

  it('accepts valid effort levels', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
    effort: xhigh
defaults:
  model: opus
  effort: medium
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects the removed allowedUsers shape with a migration hint', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
    allowedUsers:
      - "U001": [git]
permissions:
  git:
    env: []
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('"allowedUsers", which has been removed');
  });

  it('accepts valid permissions via users + members', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
    members: [alice, bob]
users:
  alice: { permissions: [git, jiraWrite] }
  bob: {}
permissions:
  git:
    env: []
  jiraWrite:
    env: []
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).not.toThrow();
  });

  it('accepts custom permissions in the users registry', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
users:
  alice: { permissions: [git, langfuse] }
permissions:
  git:
    env: []
  langfuse:
    env: [LANGFUSE_KEY]
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects permission not defined in permissions section', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
users:
  alice: { permissions: [git, undefined_perm] }
permissions:
  git:
    env: []
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('unknown permission "undefined_perm"');
  });

  it('injects the built-in claude credential on load', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig();
    expect(config.userCredentials?.claude?.fields).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { label: 'Claude Code OAuth token' },
    });
  });

  it('accepts userCredentials fields with explicit defaultFromEnv and exposeAs', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
userCredentials:
  jira:
    label: Jira
    exposeAs: env
    fields:
      JIRA_USERNAME:
        label: Jira email
        secret: false
        defaultFromEnv: SHARED_JIRA_USERNAME
      JIRA_API_TOKEN:
        defaultFromEnv: SHARED_JIRA_API_TOKEN
  github:
    label: GitHub
    exposeAs: git-credential-helper
    fields:
      GITHUB_TOKEN:
        defaultFromEnv: SHARED_GITHUB_TOKEN
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects legacy userCredentials env/inject/fallback/requiresPermission keys', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
userCredentials:
  jira:
    label: Jira
    env: [JIRA_USERNAME, JIRA_API_TOKEN]
    fallback: shared
    inject: env
    requiresPermission: jiraWrite
permissions:
  jiraWrite:
    env: []
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('userCredentials.jira.env is no longer supported');
  });

  it('rejects a user-defined claude credential (built-in)', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
userCredentials:
  claude:
    label: "Claude token"
    env: [CLAUDE_CODE_OAUTH_TOKEN]
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    expect(() => loadConfig()).toThrow('userCredentials.claude is built-in');
  });

  it('accepts a valid mcpReadOnlyServers list and rejects non-string entries', () => {
    const base = (mcpReadOnlyServers: string) => `
channels:
  C001:
    name: test
    folder: /test
userCredentials:
  jira:
    label: Jira
    fields:
      JIRA_API_TOKEN: {}
    mcpReadOnlyServers: ${mcpReadOnlyServers}
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), base('[mcp-atlassian]'));
    expect(() => loadConfig()).not.toThrow();

    writeFileSync(join(tmpDir, 'config.yaml'), base('"mcp-atlassian"'));
    expect(() => loadConfig()).toThrow(
      'userCredentials.jira.mcpReadOnlyServers must be a list of MCP server names',
    );

    writeFileSync(join(tmpDir, 'config.yaml'), base('[""]'));
    expect(() => loadConfig()).toThrow(
      'userCredentials.jira.mcpReadOnlyServers must be a list of MCP server names',
    );
  });
});

describe('resolveFolder', () => {
  it('resolves folder name to .repos/<name> under cwd', () => {
    const result = resolveFolder('my-repo');
    expect(result).toBe(join(DATA_DIR, 'repos', 'my-repo'));
  });
});

describe('resolvedChannelConfig with repos', () => {
  it('resolves repo to .repos/<name> when repos map exists', () => {
    const config: Config = {
      repos: {
        'my-repo': { url: 'https://github.com/org/my-repo.git' },
      },
      channels: {
        C001: { name: 'test', repo: 'my-repo' },
      },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    const result = resolvedChannelConfig(config, 'C001');
    expect(result?.folder).toBe(join(DATA_DIR, 'repos', 'my-repo'));
  });

  it('falls back to folder field when repo is absent', () => {
    const config: Config = {
      repos: {
        'my-repo': { url: 'https://github.com/org/my-repo.git' },
      },
      channels: {
        C001: { name: 'test', folder: 'my-repo' },
      },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    const result = resolvedChannelConfig(config, 'C001');
    expect(result?.folder).toBe(join(DATA_DIR, 'repos', 'my-repo'));
  });

  it('keeps folder as-is when repos map is absent', () => {
    const config: Config = {
      channels: {
        C001: { name: 'test', folder: '/projects/test' },
      },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    const result = resolvedChannelConfig(config, 'C001');
    expect(result?.folder).toBe('/projects/test');
  });
});

describe('voiceServer config', () => {
  let tmpDir: string;
  const originalCwd = process.cwd;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeway-voice-config-'));
    process.cwd = () => tmpDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config with voiceServer section', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
voiceServer:
  enabled: true
  port: 8765
  auth:
    tokens:
      - token: secret123
        userId: U001
        defaultChannel: C001
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig();
    expect(config.voiceServer?.enabled).toBe(true);
    expect(config.voiceServer?.port).toBe(8765);
    expect(config.voiceServer?.auth.tokens).toHaveLength(1);
    expect(config.voiceServer?.auth.tokens[0].userId).toBe('U001');
  });

  it('loads config without voiceServer (undefined, no error)', () => {
    const yaml = `
channels:
  C001:
    name: test
    folder: /test
defaults:
  model: opus
  systemPrompt: test
  timeoutMs: 300000
  responseMode: batch
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig();
    expect(config.voiceServer).toBeUndefined();
  });
});

describe('resolveVoiceToken', () => {
  const config: Config = {
    channels: { C001: { name: 'test', folder: '/test' } },
    defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    voiceServer: {
      enabled: true,
      port: 8765,
      auth: {
        tokens: [
          { token: 'secret-abc', userId: 'U001', defaultChannel: 'C001' },
          { token: 'secret-xyz', userId: 'U002', defaultChannel: 'C001' },
        ],
      },
    },
  };

  it('returns matching token config', () => {
    const result = resolveVoiceToken(config, 'secret-abc');
    expect(result).toEqual({ token: 'secret-abc', userId: 'U001', defaultChannel: 'C001' });
  });

  it('returns null for non-matching token', () => {
    expect(resolveVoiceToken(config, 'wrong-token')).toBeNull();
  });

  it('returns null when voiceServer is absent', () => {
    const noVoice: Config = {
      channels: { C001: { name: 'test', folder: '/test' } },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    expect(resolveVoiceToken(noVoice, 'anything')).toBeNull();
  });
});

describe('interpolateEnvVars', () => {
  it('replaces env var references', () => {
    const orig = process.env.TEST_VOICE_VAR;
    process.env.TEST_VOICE_VAR = 'my-secret';
    try {
      expect(interpolateEnvVars('${TEST_VOICE_VAR}')).toBe('my-secret');
    } finally {
      if (orig === undefined) delete process.env.TEST_VOICE_VAR;
      else process.env.TEST_VOICE_VAR = orig;
    }
  });

  it('replaces missing env vars with empty string', () => {
    expect(interpolateEnvVars('${NONEXISTENT_VAR_12345}')).toBe('');
  });

  it('leaves strings without env var syntax unchanged', () => {
    expect(interpolateEnvVars('plain-token')).toBe('plain-token');
  });

  it('resolves voice token with env var interpolation', () => {
    const orig = process.env.TEST_VOICE_TOKEN;
    process.env.TEST_VOICE_TOKEN = 'resolved-secret';
    try {
      const config: Config = {
        channels: { C001: { name: 'test', folder: '/test' } },
        defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
        voiceServer: {
          enabled: true,
          port: 8765,
          auth: {
            tokens: [{ token: '${TEST_VOICE_TOKEN}', userId: 'U001', defaultChannel: 'C001' }],
          },
        },
      };
      const result = resolveVoiceToken(config, 'resolved-secret');
      expect(result?.userId).toBe('U001');
    } finally {
      if (orig === undefined) delete process.env.TEST_VOICE_TOKEN;
      else process.env.TEST_VOICE_TOKEN = orig;
    }
  });
});
