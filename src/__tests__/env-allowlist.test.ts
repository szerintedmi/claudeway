import { homedir } from 'os';
import { join } from 'path';
import { buildAllowedEnv, processIdentityKey } from '../claude.js';
import { buildInjectedEnv } from '../claude-spawn-env.js';
import type { ClaudeOptions } from '../claude.js';
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
      userPermissions: new Set(['jiraWrite']),
    });
    expect(envWithPerm.JIRA_API_TOKEN).toBe('jira-tok');
    expect(envWithPerm.JIRA_URL).toBe('https://jira.example.com');

    // User WITHOUT jiraWrite
    const envWithoutPerm = buildAllowedEnv({
      config,
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
      userPermissions: new Set(['langfuse']),
    });
    expect(envWith.LANGFUSE_SECRET_KEY).toBe('lf-secret');

    const envWithout = buildAllowedEnv({
      config,
      userPermissions: new Set(),
    });
    expect(envWithout.LANGFUSE_SECRET_KEY).toBeUndefined();
  });

  it('includes extraEnv injected vars', () => {
    const env = buildAllowedEnv({
      config: makeConfig(),
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
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.CLAUDEWAY_TEMP_DIR).toBeUndefined();
  });

  it("provides a HOME fallback from the server's own home dir when HOME is missing", () => {
    delete process.env.HOME;
    process.env.USER = 'testuser';

    const env = buildAllowedEnv({
      config: makeConfig(),
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    // Falls back to os.homedir() — NOT a hardcoded /Users/<user> (wrong on Linux/Docker).
    expect(env.HOME).toBe(homedir());
  });

  it('skips env vars not present in process.env', () => {
    delete process.env.MISSING_VAR;

    const config = makeConfig({
      env: ['MISSING_VAR'],
    });

    const env = buildAllowedEnv({
      config,
      userPermissions: READ_ONLY_PERMISSIONS,
    });

    expect(env.MISSING_VAR).toBeUndefined();
  });

  it('injects per-user credential env at highest precedence', () => {
    process.env.JIRA_API_TOKEN = 'shared-service-account';

    const config = makeConfig({
      env: ['JIRA_API_TOKEN'],
    });

    const env = buildAllowedEnv({
      config,
      userPermissions: READ_ONLY_PERMISSIONS,
      extraEnv: { GIT_AUTHOR_NAME: 'Alice' },
      userCredEnv: { JIRA_API_TOKEN: 'personal-token' },
    });

    // user secret overrides the global/shared value
    expect(env.JIRA_API_TOKEN).toBe('personal-token');
    expect(env.GIT_AUTHOR_NAME).toBe('Alice');
  });

  it('user credential env overrides extraEnv-injected vars', () => {
    const env = buildAllowedEnv({
      config: makeConfig(),
      userPermissions: READ_ONLY_PERMISSIONS,
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'injected' },
      userCredEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'personal' },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('personal');
  });
});

describe('buildInjectedEnv', () => {
  const baseOpts = (tempDir?: string): ClaudeOptions =>
    ({
      channelId: 'C001',
      config: makeConfig(),
      userPermissions: READ_ONLY_PERMISSIONS,
      ...(tempDir ? { tempDir } : {}),
    }) as unknown as ClaudeOptions;

  it('sets CLAUDEWAY_TEMP_DIR to the session dir and TMPDIR to its tmp/ subfolder (D8)', () => {
    const sessionDir = '/base/C001/6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const env = buildInjectedEnv(baseOpts(sessionDir));

    expect(env.CLAUDEWAY_TEMP_DIR).toBe(sessionDir);
    // TMPDIR is a CHILD of the session dir, not equal to it
    expect(env.TMPDIR).toBe(join(sessionDir, 'tmp'));
    expect(env.TMPDIR).not.toBe(env.CLAUDEWAY_TEMP_DIR);
    expect(env.CLAUDEWAY_CHANNEL_ID).toBe('C001');
  });

  it('no longer emits the retired CLAUDEWAY_SCRATCH_DIR / CLAUDEWAY_TEMP_BASE vars', () => {
    const env = buildInjectedEnv(baseOpts('/base/C001/sess'));
    expect(env.CLAUDEWAY_SCRATCH_DIR).toBeUndefined();
    expect(env.CLAUDEWAY_TEMP_BASE).toBeUndefined();
  });

  it('injects nothing temp-related when no tempDir is set', () => {
    const env = buildInjectedEnv(baseOpts());
    expect(env.CLAUDEWAY_TEMP_DIR).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  });

  it('prepends the repo scripts/ dir to PATH so claudeway-attach resolves', () => {
    process.env.PATH = '/usr/bin';
    const env = buildInjectedEnv(baseOpts('/base/C001/sess'));
    const [first, ...rest] = env.PATH.split(':');
    expect(first.endsWith('/scripts')).toBe(true);
    expect(rest.join(':')).toBe('/usr/bin');
  });

  it('puts scripts/ on PATH even without a tempDir', () => {
    process.env.PATH = '/usr/bin';
    const env = buildInjectedEnv(baseOpts());
    expect(env.PATH.split(':')[0].endsWith('/scripts')).toBe(true);
  });
});

describe('processIdentityKey', () => {
  it('produces different keys for different users', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'opus', 'high');
    const key2 = processIdentityKey('U002', perms, config, 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toContain('U001');
    expect(key2).toContain('U002');
  });

  it('produces different keys for different permissions', () => {
    const config = makeConfig();
    const key1 = processIdentityKey('U001', new Set(['git', 'jiraWrite']), config, 'opus', 'high');
    const key2 = processIdentityKey('U001', new Set(), config, 'opus', 'high');
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
    const key1 = processIdentityKey('U001', perms, config1, 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config2, 'opus', 'high');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different models, equal keys for the same model', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config, 'sonnet', 'high');
    const key3 = processIdentityKey('U001', perms, config, 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
  });

  it('produces different keys for different efforts, equal keys for the same effort', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'opus', 'high');
    const key2 = processIdentityKey('U001', perms, config, 'opus', 'low');
    const key3 = processIdentityKey('U001', perms, config, 'opus', 'high');
    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
  });

  it('includes sorted env var names in the key', () => {
    const config = makeConfig({
      permissions: {
        jiraWrite: { env: ['JIRA_URL', 'JIRA_API_TOKEN'] },
      },
    });

    const key = processIdentityKey('U001', new Set(['jiraWrite']), config, 'opus', 'high');
    // Env var names should be sorted
    expect(key).toContain('JIRA_API_TOKEN,JIRA_URL');
  });

  it('changes when the secrets hash changes (token rotation mid-thread)', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const key1 = processIdentityKey('U001', perms, config, 'opus', 'high', 'hash-a');
    const key2 = processIdentityKey('U001', perms, config, 'opus', 'high', 'hash-b');
    const key3 = processIdentityKey('U001', perms, config, 'opus', 'high', 'hash-a');
    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
    // No hash (legacy callers) still works
    expect(processIdentityKey('U001', perms, config, 'opus', 'high')).toBe(
      processIdentityKey('U001', perms, config, 'opus', 'high', ''),
    );
  });

  it('changes when the read-only MCP server set changes (personal Jira enrolled mid-thread)', () => {
    const config = makeConfig();
    const perms = new Set(['git']);
    const shared = processIdentityKey('U001', perms, config, 'opus', 'high', 'h', [
      'mcp-atlassian',
    ]);
    const personal = processIdentityKey('U001', perms, config, 'opus', 'high', 'h', []);
    expect(shared).not.toBe(personal);
    // Omitted (legacy callers) equals empty set
    expect(processIdentityKey('U001', perms, config, 'opus', 'high', 'h')).toBe(personal);
  });
});
