import {
  parseAllowedUsers,
  extractAllowedUserIds,
  resolveUserPermissions,
  permissionKey,
  type AllowedUserEntry,
  type Config,
  FULL_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
} from '../config.js';
import { isUserAllowed } from '../slack-utils.js';
import { buildAccessRestrictions, appendAccessRestrictions } from '../prompt.js';

describe('parseAllowedUsers', () => {
  it('handles plain string entries as read-only', () => {
    const entries: AllowedUserEntry[] = ['U001', 'U002'];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual({ git: false, jiraWrite: false });
    expect(result.get('U002')).toEqual({ git: false, jiraWrite: false });
  });

  it('handles object entries with permissions', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git', 'jiraWrite'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual({ git: true, jiraWrite: true });
  });

  it('handles git-only permission', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual({ git: true, jiraWrite: false });
  });

  it('handles jiraWrite-only permission', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['jiraWrite'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual({ git: false, jiraWrite: true });
  });

  it('handles empty permission array as read-only', () => {
    const entries: AllowedUserEntry[] = [{ U001: [] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual({ git: false, jiraWrite: false });
  });

  it('handles mixed entries', () => {
    const entries: AllowedUserEntry[] = [
      { U001: ['git', 'jiraWrite'] },
      { U002: ['git'] },
      'U003',
      'U004',
    ];
    const result = parseAllowedUsers(entries);
    expect(result.size).toBe(4);
    expect(result.get('U001')).toEqual({ git: true, jiraWrite: true });
    expect(result.get('U002')).toEqual({ git: true, jiraWrite: false });
    expect(result.get('U003')).toEqual({ git: false, jiraWrite: false });
    expect(result.get('U004')).toEqual({ git: false, jiraWrite: false });
  });

  it('handles empty array', () => {
    const result = parseAllowedUsers([]);
    expect(result.size).toBe(0);
  });
});

describe('extractAllowedUserIds', () => {
  it('extracts IDs from plain strings', () => {
    expect(extractAllowedUserIds(['U001', 'U002'])).toEqual(['U001', 'U002']);
  });

  it('extracts IDs from object entries', () => {
    expect(extractAllowedUserIds([{ U001: ['git'] }])).toEqual(['U001']);
  });

  it('extracts IDs from mixed entries', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git'] }, 'U002', { U003: [] }];
    expect(extractAllowedUserIds(entries)).toEqual(['U001', 'U002', 'U003']);
  });
});

describe('resolveUserPermissions', () => {
  const config: Config = {
    channels: {
      C001: {
        name: 'test',
        folder: '/test',
        allowedUsers: [{ U_ADMIN: ['git', 'jiraWrite'] }, { U_DEV: ['git'] }, 'U_VIEW'],
      },
      C002: {
        name: 'open',
        folder: '/open',
        // no allowedUsers — open channel
      },
    },
    defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    botOwner: 'U_OWNER',
  };

  it('returns full permissions for botOwner', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_OWNER')).toEqual(FULL_PERMISSIONS);
  });

  it('returns full permissions for botOwner even in open channels', () => {
    expect(resolveUserPermissions(config, 'C002', 'U_OWNER')).toEqual(FULL_PERMISSIONS);
  });

  it('returns full permissions for botOwner when not listed in allowedUsers', () => {
    // U_OWNER is not listed in C001's allowedUsers — defaults to full
    expect(resolveUserPermissions(config, 'C001', 'U_OWNER')).toEqual(FULL_PERMISSIONS);
  });

  it('uses explicit permissions when botOwner is listed in allowedUsers', () => {
    const cfg: Config = {
      channels: {
        C003: {
          name: 'limited',
          folder: '/limited',
          allowedUsers: [{ U_OWNER: ['git'] }],
        },
      },
      defaults: config.defaults,
      botOwner: 'U_OWNER',
    };
    expect(resolveUserPermissions(cfg, 'C003', 'U_OWNER')).toEqual({ git: true, jiraWrite: false });
  });

  it('returns configured permissions for admin user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_ADMIN')).toEqual({
      git: true,
      jiraWrite: true,
    });
  });

  it('returns git-only for dev user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_DEV')).toEqual({
      git: true,
      jiraWrite: false,
    });
  });

  it('returns read-only for view-only user', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_VIEW')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for unknown user in restricted channel', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_UNKNOWN')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for any user in open channel (no allowedUsers)', () => {
    expect(resolveUserPermissions(config, 'C002', 'U_RANDOM')).toEqual(READ_ONLY_PERMISSIONS);
  });

  it('returns read-only for unknown channel', () => {
    expect(resolveUserPermissions(config, 'C999', 'U_RANDOM')).toEqual(READ_ONLY_PERMISSIONS);
  });
});

describe('permissionKey', () => {
  it('returns empty string for read-only', () => {
    expect(permissionKey({ git: false, jiraWrite: false })).toBe('');
  });

  it('returns git for git-only', () => {
    expect(permissionKey({ git: true, jiraWrite: false })).toBe('git');
  });

  it('returns jiraWrite for jiraWrite-only', () => {
    expect(permissionKey({ git: false, jiraWrite: true })).toBe('jiraWrite');
  });

  it('returns git,jiraWrite for full permissions', () => {
    expect(permissionKey({ git: true, jiraWrite: true })).toBe('git,jiraWrite');
  });

  it('returns git,jiraWrite for undefined (full access default)', () => {
    expect(permissionKey(undefined)).toBe('git,jiraWrite');
  });
});

describe('isUserAllowed with mixed format', () => {
  it('allows user from plain string entry', () => {
    expect(isUserAllowed(['U001', 'U002'], 'U001')).toBe(true);
  });

  it('allows user from object entry', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git'] }];
    expect(isUserAllowed(entries, 'U001')).toBe(true);
  });

  it('rejects user not in list', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git'] }, 'U002'];
    expect(isUserAllowed(entries, 'U003')).toBe(false);
  });

  it('allows everyone when allowedUsers is undefined', () => {
    expect(isUserAllowed(undefined, 'U_ANY')).toBe(true);
  });

  it('allows everyone when allowedUsers is empty', () => {
    expect(isUserAllowed([], 'U_ANY')).toBe(true);
  });
});

describe('buildAccessRestrictions', () => {
  const scratchDir = '/tmp/scratch/C001';

  it('returns empty string for full permissions', () => {
    expect(buildAccessRestrictions({ git: true, jiraWrite: true }, scratchDir)).toBe('');
  });

  it('includes git restrictions when git is false', () => {
    const result = buildAccessRestrictions({ git: false, jiraWrite: true }, scratchDir);
    expect(result).toContain('Do NOT modify, create, or delete any files');
    expect(result).toContain('git commit');
    expect(result).not.toContain('Do NOT create, update, or delete Jira');
  });

  it('includes jira restrictions when jiraWrite is false', () => {
    const result = buildAccessRestrictions({ git: true, jiraWrite: false }, scratchDir);
    expect(result).toContain('Do NOT create, update, or delete Jira');
    expect(result).not.toContain('Do NOT modify, create, or delete any files');
  });

  it('includes both restrictions for read-only', () => {
    const result = buildAccessRestrictions({ git: false, jiraWrite: false }, scratchDir);
    expect(result).toContain('Do NOT modify, create, or delete any files');
    expect(result).toContain('Jira');
  });

  it('includes scratch dir path', () => {
    const result = buildAccessRestrictions({ git: false, jiraWrite: false }, scratchDir);
    expect(result).toContain(scratchDir);
  });

  it('includes READ-ONLY mode header', () => {
    const result = buildAccessRestrictions({ git: false, jiraWrite: false }, scratchDir);
    expect(result).toContain('READ-ONLY mode');
  });
});

describe('appendAccessRestrictions', () => {
  it('returns original prompt for full permissions', () => {
    const prompt = 'You are a helpful assistant.';
    expect(appendAccessRestrictions(prompt, { git: true, jiraWrite: true }, '/tmp/scratch')).toBe(
      prompt,
    );
  });

  it('appends restrictions for read-only', () => {
    const prompt = 'You are a helpful assistant.';
    const result = appendAccessRestrictions(
      prompt,
      { git: false, jiraWrite: false },
      '/tmp/scratch',
    );
    expect(result).toContain(prompt);
    expect(result).toContain('READ-ONLY mode');
  });
});
