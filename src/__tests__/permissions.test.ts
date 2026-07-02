import {
  resolveUserPermissions,
  permissionKey,
  fullPermissions,
  READ_ONLY_PERMISSIONS,
  type Config,
} from '../config.js';
import { buildAccessRestrictions, appendAccessRestrictions } from '../prompt.js';

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

  it('includes the escalation path (owner mention + creds hint)', () => {
    const generic = buildAccessRestrictions(new Set(), scratchDir);
    expect(generic).toContain('the bot owner');
    expect(generic).toContain('!creds');

    const withOwner = buildAccessRestrictions(new Set(), scratchDir, {
      owners: ['U0OWNER', 'U0OWNER2'],
    });
    expect(withOwner).toContain('<@U0OWNER> or <@U0OWNER2>');
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
