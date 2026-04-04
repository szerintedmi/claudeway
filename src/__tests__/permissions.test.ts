import {
  parseAllowedUsers,
  extractAllowedUserIds,
  resolveUserPermissions,
  permissionKey,
  fullPermissions,
  READ_ONLY_PERMISSIONS,
  type AllowedUserEntry,
  type Config,
} from '../config.js';
import { isUserAllowed } from '../adapters/slack/utils.js';
import { buildAccessRestrictions, appendAccessRestrictions } from '../prompt.js';

describe('parseAllowedUsers', () => {
  it('handles plain string entries as read-only', () => {
    const entries: AllowedUserEntry[] = ['U001', 'U002'];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set());
    expect(result.get('U002')).toEqual(new Set());
  });

  it('handles object entries with permissions', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git', 'jiraWrite'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set(['git', 'jiraWrite']));
  });

  it('handles git-only permission', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set(['git']));
  });

  it('handles jiraWrite-only permission', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['jiraWrite'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set(['jiraWrite']));
  });

  it('handles empty permission array as read-only', () => {
    const entries: AllowedUserEntry[] = [{ U001: [] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set());
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
    expect(result.get('U001')).toEqual(new Set(['git', 'jiraWrite']));
    expect(result.get('U002')).toEqual(new Set(['git']));
    expect(result.get('U003')).toEqual(new Set());
    expect(result.get('U004')).toEqual(new Set());
  });

  it('handles custom permissions', () => {
    const entries: AllowedUserEntry[] = [{ U001: ['git', 'langfuse'] }];
    const result = parseAllowedUsers(entries);
    expect(result.get('U001')).toEqual(new Set(['git', 'langfuse']));
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
    permissions: {
      git: { env: [] },
      jiraWrite: { env: [] },
    },
  };

  it('returns full permissions for botOwner', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_OWNER')).toEqual(fullPermissions(config));
  });

  it('returns full permissions for botOwner even in open channels', () => {
    expect(resolveUserPermissions(config, 'C002', 'U_OWNER')).toEqual(fullPermissions(config));
  });

  it('returns full permissions for botOwner when not listed in allowedUsers', () => {
    expect(resolveUserPermissions(config, 'C001', 'U_OWNER')).toEqual(fullPermissions(config));
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
      permissions: config.permissions,
    };
    expect(resolveUserPermissions(cfg, 'C003', 'U_OWNER')).toEqual(new Set(['git']));
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

  it('returns read-only for any user in open channel (no allowedUsers)', () => {
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
    expect(buildAccessRestrictions(new Set(['git', 'jiraWrite']), scratchDir)).toBe('');
  });

  it('includes git restrictions when git is missing', () => {
    const result = buildAccessRestrictions(new Set(['jiraWrite']), scratchDir);
    expect(result).toContain('Do NOT modify, create, or delete any files');
    expect(result).toContain('git commit');
    expect(result).not.toContain('Do NOT create, update, or delete Jira');
  });

  it('includes jira restrictions when jiraWrite is missing', () => {
    const result = buildAccessRestrictions(new Set(['git']), scratchDir);
    expect(result).toContain('Do NOT create, update, or delete Jira');
    expect(result).not.toContain('Do NOT modify, create, or delete any files');
  });

  it('includes both restrictions for read-only', () => {
    const result = buildAccessRestrictions(new Set(), scratchDir);
    expect(result).toContain('Do NOT modify, create, or delete any files');
    expect(result).toContain('Jira');
  });

  it('includes scratch dir path', () => {
    const result = buildAccessRestrictions(new Set(), scratchDir);
    expect(result).toContain(scratchDir);
  });

  it('includes READ-ONLY mode header', () => {
    const result = buildAccessRestrictions(new Set(), scratchDir);
    expect(result).toContain('READ-ONLY mode');
  });
});

describe('appendAccessRestrictions', () => {
  it('returns original prompt for full permissions', () => {
    const prompt = 'You are a helpful assistant.';
    expect(appendAccessRestrictions(prompt, new Set(['git', 'jiraWrite']), '/tmp/scratch')).toBe(
      prompt,
    );
  });

  it('appends restrictions for read-only', () => {
    const prompt = 'You are a helpful assistant.';
    const result = appendAccessRestrictions(prompt, new Set(), '/tmp/scratch');
    expect(result).toContain(prompt);
    expect(result).toContain('READ-ONLY mode');
  });
});
