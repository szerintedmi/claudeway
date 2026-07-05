import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'node:crypto';
import {
  resolveUserCredentials,
  gitCredConfigured,
  resolveSharedGitCredential,
} from '../credentials.js';
import { FileSecretStore } from '../secrets.js';
import type { Config } from '../config.js';

const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

let dir: string;
let store: FileSecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudeway-creds-test-'));
  store = new FileSecretStore(randomBytes(32), dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    channels: { C001: { name: 'chan', folder: '/p' } },
    defaults: { model: 'opus', systemPrompt: 's', timeoutMs: 1000, responseMode: 'batch' },
    permissions: { git: {}, jiraWrite: {} },
    userCredentials: {
      jira: {
        label: 'Jira',
        fields: {
          JIRA_USERNAME: { defaultFromEnv: 'SHARED_JIRA_USERNAME' },
          JIRA_API_TOKEN: { defaultFromEnv: 'SHARED_JIRA_API_TOKEN' },
        },
      },
      github: {
        label: 'GitHub PAT',
        fields: { GITHUB_TOKEN: { defaultFromEnv: 'SHARED_GITHUB_TOKEN' } },
        exposeAs: 'git-credential-helper',
      },
      claude: {
        label: 'Claude token',
        fields: { CLAUDE_CODE_OAUTH_TOKEN: {} },
      },
    },
    ...overrides,
  };
}

describe('resolveUserCredentials', () => {
  it('returns empty when no userCredentials are configured', () => {
    const config = makeConfig({ userCredentials: undefined });
    const r = resolveUserCredentials(config, 'petro', { store });
    expect(r.env).toEqual({});
    expect(r.git).toBeNull();
    expect(r.secretsHash).toBe('');
  });

  it('injects personal env creds over the explicit shared default', () => {
    process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
    process.env.SHARED_JIRA_USERNAME = 'svc@x.com';
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'personal-jira', JIRA_USERNAME: 'p@x.com' });

    const r = resolveUserCredentials(makeConfig(), 'petro', { store });
    expect(r.env.JIRA_API_TOKEN).toBe('personal-jira');
    expect(r.env.JIRA_USERNAME).toBe('p@x.com');
    expect(r.personalCredNames).toContain('jira');
    expect(r.secretValues).toContain('personal-jira');
  });

  it('falls back to explicit shared env values for unenrolled users', () => {
    process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
    process.env.SHARED_JIRA_USERNAME = 'svc@x.com';

    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.env.JIRA_API_TOKEN).toBe('shared-jira');
    expect(r.env.JIRA_USERNAME).toBe('svc@x.com');
    expect(r.sharedCredNames).toContain('jira');
    // shared values are scrubbed too
    expect(r.secretValues).toContain('shared-jira');
  });

  it('does not treat exposed env var names as implicit defaults', () => {
    delete process.env.SHARED_JIRA_API_TOKEN;
    delete process.env.SHARED_JIRA_USERNAME;
    process.env.JIRA_API_TOKEN = 'shared-jira';
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.env.JIRA_API_TOKEN).toBeUndefined();
  });

  it('uses an enrolled credential without requiring a separate permission', () => {
    store.set('val', 'jira', { JIRA_API_TOKEN: 'personal-jira' });
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.env.JIRA_API_TOKEN).toBe('personal-jira');
  });

  it('resolves a personal git token for enrolled git users', () => {
    store.set('petro', 'github', { GITHUB_TOKEN: 'ghp_personal' });
    const r = resolveUserCredentials(makeConfig(), 'petro', { store });
    expect(r.git?.token).toBe('ghp_personal');
    expect(r.git?.source).toBe('user');
    // git tokens never enter the env
    expect(r.env.GITHUB_TOKEN).toBeUndefined();
    expect(r.secretValues).toContain('ghp_personal');
  });

  it('resolves the explicit shared git token otherwise', () => {
    process.env.SHARED_GITHUB_TOKEN = 'ghp_shared';
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.git?.token).toBe('ghp_shared');
    expect(r.git?.source).toBe('shared');
    expect(r.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('does not treat GITHUB_TOKEN as an implicit shared git token', () => {
    delete process.env.SHARED_GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_ambient';
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.git).toBeNull();
  });

  it('uses configured git credentials for the botOwner too', () => {
    process.env.SHARED_GITHUB_TOKEN = 'ghp_shared';
    store.set('owner', 'github', { GITHUB_TOKEN: 'ghp_owner' });
    const r = resolveUserCredentials(makeConfig(), 'owner', { store });
    expect(r.git?.token).toBe('ghp_owner');
    expect(r.git?.source).toBe('user');
  });

  it('flags missingClaudeCred for unenrolled users when claude is configured', () => {
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.missingClaudeCred).toBe(true);
  });

  it('flags missingClaudeCred for the bot owner too (no owner exemption)', () => {
    const r = resolveUserCredentials(makeConfig(), 'owner', { store });
    expect(r.missingClaudeCred).toBe(true);
  });

  it('injects a personal Claude token and clears missingClaudeCred', () => {
    store.set('val', 'claude', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-personal' });
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-personal');
    expect(r.missingClaudeCred).toBe(false);
  });

  it('flags missingClaudeCred even when other credentials resolve (claude is built-in)', () => {
    process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
    const r = resolveUserCredentials(makeConfig(), 'val', { store });
    expect(r.sharedCredNames).toContain('jira');
    expect(r.missingClaudeCred).toBe(true);
  });

  it('reports a status per registry credential (source + sharedAccessNote)', () => {
    delete process.env.SHARED_GITHUB_TOKEN;
    process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
    process.env.SHARED_JIRA_USERNAME = 'svc@x.com';
    store.set('val', 'claude', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-personal' });
    const config = makeConfig();
    config.userCredentials!.jira.sharedAccessNote = 'read-only — Jira writes will fail';

    const r = resolveUserCredentials(config, 'val', { store });
    expect(r.statuses).toEqual([
      {
        name: 'jira',
        label: 'Jira',
        source: 'shared',
        note: 'read-only — Jira writes will fail',
      },
      { name: 'github', label: 'GitHub PAT', source: 'none' },
      { name: 'claude', label: 'Claude token', source: 'personal' },
    ]);
  });

  it('omits the note for personal resolutions', () => {
    const config = makeConfig();
    config.userCredentials!.jira.sharedAccessNote = 'read-only';
    store.set('val', 'jira', { JIRA_API_TOKEN: 'personal-jira' });
    const r = resolveUserCredentials(config, 'val', { store });
    const jira = r.statuses.find((s) => s.name === 'jira');
    expect(jira).toEqual({ name: 'jira', label: 'Jira', source: 'personal' });
  });

  it('secretsHash changes when a stored value changes', () => {
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'v1' });
    const r1 = resolveUserCredentials(makeConfig(), 'petro', { store });
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'v2' });
    const r2 = resolveUserCredentials(makeConfig(), 'petro', { store });
    expect(r1.secretsHash).not.toBe(r2.secretsHash);
    expect(r1.secretsHash).not.toContain('v1');
  });

  describe('readOnlyMcpServers', () => {
    it('forces the listed servers read-only on shared fallback', () => {
      process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
      const config = makeConfig();
      config.userCredentials!.jira.mcpReadOnlyServers = ['mcp-atlassian'];
      const r = resolveUserCredentials(config, 'val', { store });
      expect(r.readOnlyMcpServers).toEqual(['mcp-atlassian']);
    });

    it('forces the listed servers read-only when the credential is unset', () => {
      delete process.env.SHARED_JIRA_API_TOKEN;
      delete process.env.SHARED_JIRA_USERNAME;
      const config = makeConfig();
      config.userCredentials!.jira.mcpReadOnlyServers = ['mcp-atlassian'];
      const r = resolveUserCredentials(config, 'val', { store });
      expect(r.readOnlyMcpServers).toEqual(['mcp-atlassian']);
    });

    it('does not force read-only when a personal secret is enrolled', () => {
      process.env.SHARED_JIRA_API_TOKEN = 'shared-jira';
      const config = makeConfig();
      config.userCredentials!.jira.mcpReadOnlyServers = ['mcp-atlassian'];
      store.set('val', 'jira', { JIRA_API_TOKEN: 'personal-jira' });
      const r = resolveUserCredentials(config, 'val', { store });
      expect(r.readOnlyMcpServers).toEqual([]);
    });

    it('dedupes and sorts across credentials', () => {
      const config = makeConfig();
      config.userCredentials!.jira.mcpReadOnlyServers = ['zeta', 'mcp-atlassian'];
      config.userCredentials!.github.mcpReadOnlyServers = ['mcp-atlassian'];
      const r = resolveUserCredentials(config, 'val', { store });
      expect(r.readOnlyMcpServers).toEqual(['mcp-atlassian', 'zeta']);
    });

    it('is empty when no credential declares mcpReadOnlyServers', () => {
      const r = resolveUserCredentials(makeConfig(), 'val', { store });
      expect(r.readOnlyMcpServers).toEqual([]);
    });
  });
});

describe('config helpers', () => {
  it('gitCredConfigured reflects the registry', () => {
    expect(gitCredConfigured(makeConfig())).toBe(true);
    const bare = makeConfig({ userCredentials: undefined });
    expect(gitCredConfigured(bare)).toBe(false);
  });
});

describe('resolveSharedGitCredential', () => {
  it('resolves the git-credential-helper credential from its env default', () => {
    process.env.SHARED_GITHUB_TOKEN = 'ghp_shared';
    const cred = resolveSharedGitCredential(makeConfig());
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe('ghp_shared');
    expect(cred?.source).toBe('shared');
    expect(cred?.cacheKey).toBe('shared|github');
  });

  it('returns null when the shared env default is unset', () => {
    delete process.env.SHARED_GITHUB_TOKEN;
    expect(resolveSharedGitCredential(makeConfig())).toBeNull();
  });

  it('returns null when no git-credential-helper credential is configured', () => {
    process.env.SHARED_GITHUB_TOKEN = 'ghp_shared';
    const config = makeConfig({
      userCredentials: {
        jira: {
          label: 'Jira',
          fields: { JIRA_API_TOKEN: { defaultFromEnv: 'SHARED_JIRA_API_TOKEN' } },
        },
      },
    });
    expect(resolveSharedGitCredential(config)).toBeNull();
  });
});
