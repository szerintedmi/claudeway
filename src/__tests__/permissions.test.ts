import {
  resolveUserPermissions,
  permissionKey,
  fullPermissions,
  READ_ONLY_PERMISSIONS,
  type Config,
} from '../config.js';

describe('resolveUserPermissions', () => {
  const config: Config = {
    channels: {
      C001: {
        name: 'test',
        folder: '/test',
        members: ['admin', 'dev', 'view'],
      },
      C002: {
        name: 'open',
        folder: '/open',
        // no members — open channel
      },
    },
    defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    botOwners: ['U_OWNER'],
    permissions: {
      git: { env: [] },
      jiraWrite: { env: [] },
    },
    users: {
      admin: { slack: 'U_ADMIN', permissions: ['git', 'jiraWrite'] },
      dev: { slack: 'U_DEV', permissions: ['git'] },
      view: { slack: 'U_VIEW' },
    },
  };

  it('returns full permissions for botOwner', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_OWNER')).toEqual(fullPermissions(config));
  });

  it('returns full permissions for botOwner even in open channels', () => {
    expect(resolveUserPermissions(config, 'C002', 'U_OWNER')).toEqual(fullPermissions(config));
  });

  it('uses explicit permissions when botOwner is listed in the registry', () => {
    const cfg: Config = {
      ...config,
      users: { ...config.users, owner: { slack: 'U_OWNER', permissions: ['git'] } },
    };
    expect(resolveUserPermissions(cfg, 'C001', 'U_OWNER')).toEqual(new Set(['git']));
  });

  it('returns configured permissions for admin user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_ADMIN')).toEqual(
      new Set(['git', 'jiraWrite']),
    );
  });

  it('returns git-only for dev user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_DEV')).toEqual(new Set(['git']));
  });

  it('returns read-only for view-only user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_VIEW')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for unknown user in restricted channel', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_UNKNOWN')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for any user in open channel (no members)', () => {
    expect(resolveUserPermissions(config, 'C002', 'U_RANDOM')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for unknown channel', () => {
    expect(resolveUserPermissions(config, 'C999', 'U_RANDOM')).toEqual(READ_ONLY_PERMISSIONS);
  });
});

describe('permissionKey', () => {
  it('returns empty string for read-only', () => {
    expect(permissionKey(new Set())).toBe('');
  });

  it('returns git for git-only', () => {
    expect(permissionKey(new Set(['git']))).toBe('git');
  });

  it('returns jiraWrite for jiraWrite-only', () => {
    expect(permissionKey(new Set(['jiraWrite']))).toBe('jiraWrite');
  });

  it('returns sorted permissions for full', () => {
    expect(permissionKey(new Set(['jiraWrite', 'git']))).toBe('git,jiraWrite');
  });

  it('returns * for undefined (full access default)', () => {
    expect(permissionKey(undefined)).toBe('*');
  });

  it('handles custom permissions', () => {
    expect(permissionKey(new Set(['git', 'langfuse']))).toBe('git,langfuse');
  });
});
