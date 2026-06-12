import { buildAllowedEnv, processIdentityKey } from '../claude.js';
import type { Config } from '../config.js';
import { READ_ONLY_PERMISSIONS } from '../config.js';

// Save and restore process.env around tests
const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    channels: {
      C001: { name: 'test-channel', folder: '/projects/test' },
    },
    defaults: {
      model: 'opus',
      systemPrompt: 'test',
      timeoutMs: 300000,
      responseMode: 'batch',
    },
    ...overrides,
  };
}

describe('buildAllowedEnv', () => {
  it('includes baseline vars from process.env', () => {
    process.env.HOME = '/home/test';
    process.env.PATH = '/usr/bin';
    process.env.SHELL = '/bin/zsh';
    process.env.SECRET_KEY = 'should-not-leak';

    const env = buildAllowedEnv({
      config: makeConfig(),
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.HOME).toBe('/home/test');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.SECRET_KEY).toBeUndefined();
  });

  it('includes global env vars', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok123';
    process.env.SLACK_BOT_TOKEN = 'xoxb-should-not-leak';

    const config = makeConfig({
      env: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });

    const env = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok123');
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it('includes permission-linked env vars when user has permission', () => {
    process.env.JIRA_API_TOKEN = 'jira-tok';
    process.env.JIRA_URL = 'https://jira.example.com';

    const config = makeConfig({
      permissions: {
        jiraWrite: { env: ['JIRA_API_TOKEN', 'JIRA_URL'] },
      },
    });

    // User WITH jiraWrite
    const envWithPerm = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: new Set(['jiraWrite']),
    });
    expect(envWithPerm.JIRA_API_TOKEN).toBe('jira-tok');
    expect(envWithPerm.JIRA_URL).toBe('https://jira.example.com');

    // User WITHOUT jiraWrite
    const envWithoutPerm = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });
    expect(envWithoutPerm.JIRA_API_TOKEN).toBeUndefined();
    expect(envWithoutPerm.JIRA_URL).toBeUndefined();
  });

  it('includes custom permission env vars', () => {
    process.env.LANGFUSE_SECRET_KEY = 'lf-secret';

    const config = makeConfig({
      permissions: {
        langfuse: { env: ['LANGFUSE_SECRET_KEY'] },
      },
    });

    const envWith = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: new Set(['langfuse']),
    });
    expect(envWith.LANGFUSE_SECRET_KEY).toBe('lf-secret');

    const envWithout = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: new Set(),
    });
    expect(envWithout.LANGFUSE_SECRET_KEY).toBeUndefined();
  });

  it('includes extraEnv injected vars', () => {
    const env = buildAllowedEnv({
      config: makeConfig(),
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
      extraEnv: {
        CLAUDEWAY_TEMP_DIR: '/tmp/test',
        GIT_AUTHOR_NAME: 'Alice',
      },
    });

    expect(env.CLAUDEWAY_TEMP_DIR).toBe('/tmp/test');
    expect(env.GIT_AUTHOR_NAME).toBe('Alice');
  });

  it('does not pass through CLAUDEWAY_* from process.env', () => {
    process.env.CLAUDEWAY_TEMP_DIR = '/should-not-leak';

    const env = buildAllowedEnv({
      config: makeConfig(),
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.CLAUDEWAY_TEMP_DIR).toBeUndefined();
  });

  it('provides HOME fallback from USER when HOME is missing', () => {
    delete process.env.HOME;
    process.env.USER = 'testuser';

    const env = buildAllowedEnv({
      config: makeConfig(),
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.HOME).toBe('/Users/testuser');
  });

  it('skips env vars not present in process.env', () => {
    delete process.env.MISSING_VAR;

    const config = makeConfig({
      env: ['MISSING_VAR'],
    });

    const env = buildAllowedEnv({
      config,
      channelId: 'C001',
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.MISSING_VAR).toBeUndefined();
  });
});

describe('processIdentityKey', () => {
  it('produces different keys for different users', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'high');
    const key2 = processIdentityKey('U002', perms, config, 'C001', 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toContain('U001');
    expect(key2).toContain('U002');
  });

  it('produces different keys for different permissions', () => {
    const config = makeConfig();
    const key1 = processIdentityKey(
      'U001',
      new Set(['git', 'jiraWrite']),
      config,
      'C001',
      'opus',
      'high',
    );
    const key2 = processIdentityKey('U001', new Set(), config, 'C001', 'opus', 'high');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys when env exposure changes', () => {
    const config1 = makeConfig({
      env: ['TOKEN_A'],
    });
    const config2 = makeConfig({
      env: ['TOKEN_A', 'TOKEN_B'],
    });

    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config1, 'C001', 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config2, 'C001', 'opus', 'high');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different models, equal keys for the same model', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config, 'C001', 'sonnet', 'high');
    const key3 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
  });

  it('produces different keys for different efforts, equal keys for the same effort', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'low');
    const key3 = processIdentityKey('U001', perms, config, 'C001', 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
  });

  it('includes sorted env var names in the key', () => {
    const config = makeConfig({
      permissions: {
        jiraWrite: { env: ['JIRA_URL', 'JIRA_API_TOKEN'] },
      },
    });

    const key = processIdentityKey('U001', new Set(['jiraWrite']), config, 'C001', 'opus', 'high');
    // Env var names should be sorted
    expect(key).toContain('JIRA_API_TOKEN,JIRA_URL');
  });
});
