import {
  resolveUser,
  resolveUserPermissions,
  resolveCanonicalUserId,
  isUserAllowedInChannel,
  isUserAllowedAnywhere,
  resolveGlobalPermissions,
  botOwnerSlackIds,
  parseMembers,
  type Config,
} from '../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botOwners: ['U0OWNER'],
    permissions: { git: {}, jiraWrite: {}, langfuse: {} },
    channels: {
      C001: { name: 'chan', folder: '/p' },
    },
    defaults: { model: 'opus', systemPrompt: 's', timeoutMs: 1000, responseMode: 'batch' },
    ...overrides,
  };
}

const registryConfig = makeConfig({
  users: {
    petro: { name: 'Petro', slack: 'U0PETRO', voice: 'voice-petro', permissions: ['git'] },
    val: { slack: 'U0VAL' },
  },
  channels: {
    C001: { name: 'chan', folder: '/p', members: ['petro', { val: ['langfuse'] }] },
    C002: { name: 'open', folder: '/p' },
    C003: { name: 'boost', folder: '/p', members: [{ petro: ['jiraWrite'] }] },
  },
});

describe('resolveCanonicalUserId', () => {
  it('maps slack and voice ids to the registry key', () => {
    expect(resolveCanonicalUserId(registryConfig, 'U0PETRO')).toBe('petro');
    expect(resolveCanonicalUserId(registryConfig, 'voice-petro')).toBe('petro');
    expect(resolveCanonicalUserId(registryConfig, 'petro')).toBe('petro');
  });

  it('keeps the external id for unregistered users', () => {
    expect(resolveCanonicalUserId(registryConfig, 'U0STRANGER')).toBe('U0STRANGER');
  });
});

describe('resolveUser', () => {
  it('resolves registry permissions via Slack id', () => {
    const u = resolveUser(registryConfig, 'C001', 'U0PETRO');
    expect(u.userId).toBe('petro');
    expect(u.name).toBe('Petro');
    expect(u.registered).toBe(true);
    expect([...u.permissions].sort()).toEqual(['git']);
  });

  it('resolves the same person via voice id (stable canonical id)', () => {
    const slack = resolveUser(registryConfig, 'C001', 'U0PETRO');
    const voice = resolveUser(registryConfig, 'C001', 'voice-petro');
    expect(voice.userId).toBe(slack.userId);
    expect([...voice.permissions].sort()).toEqual([...slack.permissions].sort());
  });

  it('channel member extras are additive', () => {
    const u = resolveUser(registryConfig, 'C003', 'U0PETRO');
    expect([...u.permissions].sort()).toEqual(['git', 'jiraWrite']);
  });

  it('plain member entry keeps registry permissions only', () => {
    const u = resolveUser(registryConfig, 'C001', 'U0VAL');
    expect([...u.permissions].sort()).toEqual(['langfuse']);
  });

  it('unregistered non-owner gets read-only', () => {
    const u = resolveUser(registryConfig, 'C001', 'U0STRANGER');
    expect(u.permissions.size).toBe(0);
    expect(u.registered).toBe(false);
  });

  it('botOwner gets full permissions implicitly', () => {
    const u = resolveUser(registryConfig, 'C001', 'U0OWNER');
    expect(u.isBotOwner).toBe(true);
    expect([...u.permissions].sort()).toEqual(['git', 'jiraWrite', 'langfuse']);
  });

  it('recognizes the owner through their voice identity (registry unifies the person)', () => {
    const cfg = makeConfig({
      users: { owner: { slack: 'U0OWNER', voice: 'voice-owner', permissions: ['git'] } },
    });
    const u = resolveUser(cfg, 'C001', 'voice-owner');
    expect(u.isBotOwner).toBe(true);
    expect(u.userId).toBe('owner');
  });

  it('accepts users registry keys as botOwners entries', () => {
    const cfg = makeConfig({
      botOwners: ['boss'],
      users: { boss: { slack: 'U0BOSS', voice: 'voice-boss' } },
    });
    // Every identity of the person resolves as owner
    expect(resolveUser(cfg, 'C001', 'U0BOSS').isBotOwner).toBe(true);
    expect(resolveUser(cfg, 'C001', 'voice-boss').isBotOwner).toBe(true);
    expect(resolveUser(cfg, 'C001', 'boss').isBotOwner).toBe(true);
    expect(resolveUser(cfg, 'C001', 'U0OTHER').isBotOwner).toBe(false);
  });

  it('botOwner explicitly listed in the registry keeps the listed permissions (testing aid)', () => {
    const cfg = makeConfig({
      users: { owner: { slack: 'U0OWNER', permissions: [] } },
    });
    const u = resolveUser(cfg, 'C001', 'U0OWNER');
    expect(u.permissions.size).toBe(0);
  });

  it('resolveUserPermissions delegates to resolveUser', () => {
    expect([...resolveUserPermissions(registryConfig, 'C001', 'U0PETRO')].sort()).toEqual(
      [...resolveUser(registryConfig, 'C001', 'U0PETRO').permissions].sort(),
    );
  });
});

describe('isUserAllowedInChannel', () => {
  it('is open when members does not restrict', () => {
    expect(isUserAllowedInChannel(registryConfig, 'C002', 'U0ANYONE')).toBe(true);
  });

  it('gates on members (by any of the user identities)', () => {
    expect(isUserAllowedInChannel(registryConfig, 'C001', 'U0PETRO')).toBe(true);
    expect(isUserAllowedInChannel(registryConfig, 'C001', 'voice-petro')).toBe(true);
    expect(isUserAllowedInChannel(registryConfig, 'C001', 'U0STRANGER')).toBe(false);
  });
});

describe('isUserAllowedAnywhere', () => {
  it('accepts botOwner, registered users, and members of open channels', () => {
    expect(isUserAllowedAnywhere(registryConfig, 'U0OWNER')).toBe(true);
    expect(isUserAllowedAnywhere(registryConfig, 'U0PETRO')).toBe(true);
    // open channel C002 exists → anyone is allowed somewhere
    expect(isUserAllowedAnywhere(registryConfig, 'U0STRANGER')).toBe(true);
  });

  it('rejects strangers when every channel is restricted', () => {
    const cfg = makeConfig({
      users: { petro: { slack: 'U0PETRO' } },
      channels: { C001: { name: 'chan', folder: '/p', members: ['petro'] } },
    });
    expect(isUserAllowedAnywhere(cfg, 'U0STRANGER')).toBe(false);
    expect(isUserAllowedAnywhere(cfg, 'U0PETRO')).toBe(true);
  });

  it('registry presence alone does not grant access — needs ≥1 channel', () => {
    const cfg = makeConfig({
      users: {
        petro: { slack: 'U0PETRO' },
        ghost: { slack: 'U0GHOST' }, // registered but member of nothing
      },
      channels: { C001: { name: 'chan', folder: '/p', members: ['petro'] } },
    });
    expect(isUserAllowedAnywhere(cfg, 'U0GHOST')).toBe(false);
  });
});

describe('resolveGlobalPermissions', () => {
  it('unions registry and per-channel extras (enrollment gating)', () => {
    const perms = resolveGlobalPermissions(registryConfig, 'petro');
    expect([...perms].sort()).toEqual(['git', 'jiraWrite']);
  });

  it('botOwner gets full permissions', () => {
    const cfg = makeConfig({ users: { owner: { slack: 'U0OWNER' } } });
    expect(resolveGlobalPermissions(cfg, 'owner').size).toBe(3);
  });
});

describe('botOwnerSlackIds', () => {
  it('resolves registry keys to Slack ids, passes raw ids through', () => {
    const cfg = makeConfig({
      botOwners: ['boss', 'U0RAW'],
      users: { boss: { slack: 'U0BOSS' } },
    });
    expect(botOwnerSlackIds(cfg)).toEqual(['U0BOSS', 'U0RAW']);
    expect(botOwnerSlackIds(makeConfig({ botOwners: undefined }))).toEqual([]);
  });
});

describe('parseMembers', () => {
  it('parses mixed entries', () => {
    const map = parseMembers(['alice', { bob: ['git'] }]);
    expect(map.get('alice')?.size).toBe(0);
    expect([...(map.get('bob') ?? [])]).toEqual(['git']);
  });
});
