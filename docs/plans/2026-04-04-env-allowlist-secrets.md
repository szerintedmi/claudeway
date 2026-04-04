# Unified Permissions & Env Var Allowlist

## Context

Claude subprocesses currently inherit **all** of `process.env` minus a hardcoded 3-item denylist (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `CLAUDECODE`). This is brittle — any new secret (Deepgram API key, Jira token, SSH key) leaks to Claude unless manually added. The denylist is also duplicated in two places: `spawnClaudeProcess()` and `createPersistentProcess()`.

Additionally, the permission model (`git`, `jiraWrite`) is hardcoded as a boolean struct with enforcement scattered across prompt injection, git credential stripping, and MCP config gating. Adding a new "permission" that only needs env var exposure (like `langfuse`) requires code changes.

**Goal:** Unify capabilities and env var exposure into a single `permissions` config section. Each permission is a named bundle of env vars, and known names (`git`, `jiraWrite`) additionally trigger built-in enforcement. Single code path for Docker and non-Docker runners. No backward compatibility needed.

### Design Principles

1. **Permissions are config-defined** — permission names come from `config.permissions` keys, not a hardcoded enum. `UserPermissions` becomes `Set<string>` instead of `{ git: boolean; jiraWrite: boolean }`.

2. **Known names have built-in enforcement** — `git` and `jiraWrite` are recognized by the code for enforcement (prompt restrictions, git credential stripping, MCP config gating). Any other name is custom — env-var-only.

3. **One concept, not two** — no separate `secrets` section. Global env vars go in `config.env`, per-permission env vars go in `permissions.<name>.env`.

4. **No wildcards** — `CLAUDEWAY_*` vars are explicitly enumerated at each spawn site, not glob-passed from `process.env`.

5. **Persistent restart key includes user identity** — fixes the existing bug where Alice's git author env leaks to Bob's commits when both have the same permission set.

---

## Config Shape

```yaml
# Global env — every Claude subprocess gets these
env: [CLAUDE_CODE_OAUTH_TOKEN]

# Permission definitions — each bundles env vars + optional built-in enforcement
permissions:
  git:
    env: [GIT_SSH_KEY_PATH]
    # Built-in: enables git credentials + author identity; without it, git auth is blocked
  jiraWrite:
    env: [JIRA_API_TOKEN, JIRA_URL, JIRA_EMAIL]
    # Built-in: enables full MCP config; without it, read-only MCP
  langfuse:
    env: [LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_HOST]
    # No built-in enforcement — pure env vars

channels:
  C012:
    name: my-project
    allowedUsers:
      - "U001": [git, jiraWrite, langfuse]  # gets all env vars + all enforcement unlocked
      - "U002": [git, langfuse]              # git + langfuse env vars, Jira read-only
      - "U003"                               # read-only, global env only
```

**Resolution for user U001 in channel C012:**
baseline (`HOME`, `PATH`, etc.) + global env (`CLAUDE_CODE_OAUTH_TOKEN`) + git env (`GIT_SSH_KEY_PATH`) + jiraWrite env (`JIRA_API_TOKEN`, `JIRA_URL`, `JIRA_EMAIL`) + langfuse env (`LANGFUSE_*`) + git enforcement unlocked + full MCP config

---

## Implementation Steps

### Step 1: Change `UserPermissions` type (`src/config.ts`)

Replace the boolean struct with a `Set<string>`:

```typescript
// Before:
export interface UserPermissions { git: boolean; jiraWrite: boolean }
export const FULL_PERMISSIONS: UserPermissions = { git: true, jiraWrite: true };
export const READ_ONLY_PERMISSIONS: UserPermissions = { git: false, jiraWrite: false };
const VALID_PERMISSIONS = new Set(['git', 'jiraWrite']);

// After:
export type UserPermissions = Set<string>;
export const READ_ONLY_PERMISSIONS: UserPermissions = new Set<string>();
export function fullPermissions(config: Config): UserPermissions {
  return new Set(Object.keys(config.permissions ?? {}));
}
// VALID_PERMISSIONS derived from config.permissions keys at validation time
```

### Step 2: Add permission config types (`src/config.ts`)

```typescript
export interface PermissionDef {
  env?: string[];
}

export interface Config {
  // ... existing fields ...
  env?: string[];                              // global env var names
  permissions?: Record<string, PermissionDef>; // named permission definitions
  // Remove: secrets?: SecretsConfig
}

// Remove: SecretsConfig interface
// Remove: secrets from ChannelConfig
```

### Step 3: Update parsing and validation (`src/config.ts`)

**`parseAllowedUsers`** returns `Map<string, Set<string>>`:
- Plain string → `new Set()`
- Object entry → `new Set(perms)`

**`resolveUserPermissions`** returns `Set<string>`:
- botOwner → `fullPermissions(config)`
- Explicit user → parsed set
- Not listed → `new Set()`

**`permissionKey`** for persistent process comparison:
- `undefined` → `'*'`
- Otherwise → `[...p].sort().join(',')`

**Validation in `loadConfig()`:**
- Permission names in `allowedUsers` must exist in `config.permissions`
- Warn about env vars in permission defs not present in `process.env`
- Warn about global `env` entries not present in `process.env`
- Remove all `secrets`-related validation

### Step 4: Update enforcement checks

**`src/prompt.ts`** — `buildAccessRestrictions`:
- `permissions.git` → `permissions.has('git')`
- `permissions.jiraWrite` → `permissions.has('jiraWrite')`

**`src/mcp.ts`** — `getMcpConfigPath`:
- `permissions?.jiraWrite ?? true` → `permissions?.has('jiraWrite') ?? true`

**`src/claude.ts`** — `buildPermissionsEnv`:
- `!options.userPermissions.git` → `!options.userPermissions.has('git')`

### Step 5: Rewrite `buildAllowedEnv()` (`src/claude.ts`)

```typescript
export function buildAllowedEnv(ctx: AllowedEnvContext): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Baseline vars from process.env
  for (const key of BASELINE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // 2. Global env vars
  for (const varName of ctx.config.env ?? []) {
    if (process.env[varName]) env[varName] = process.env[varName]!;
  }

  // 3. Permission-linked env vars
  for (const permName of ctx.userPermissions) {
    for (const varName of ctx.config.permissions?.[permName]?.env ?? []) {
      if (process.env[varName]) env[varName] = process.env[varName]!;
    }
  }

  // 4. Explicit injected vars
  if (ctx.extraEnv) Object.assign(env, ctx.extraEnv);

  // 5. HOME fallback
  if (!env.HOME && env.USER) env.HOME = `/Users/${env.USER}`;

  return env;
}
```

### Step 6: Update `resolveExposedEnvVarNames()` (`src/claude.ts`)

```typescript
function resolveExposedEnvVarNames(
  config: Config,
  channelId: string,
  permissions: UserPermissions,
): string[] {
  const vars = new Set<string>();

  // Global env
  for (const v of config.env ?? []) vars.add(v);

  // Permission-linked env
  for (const permName of permissions) {
    for (const v of config.permissions?.[permName]?.env ?? []) vars.add(v);
  }

  return [...vars].sort();
}
```

### Step 7: Pass config through engine (`src/core/engine.ts`)

Already done — `config` is in `PermissionContext`. Just adapt to `Set<string>` type for `userPermissions`.

### Step 8: Update config files

**`config.example.yaml`** — replace `secrets` section with `env` + `permissions`, with comments explaining built-in enforcement for `git` and `jiraWrite`.

**`config.yaml`** — replace `secrets` with actual `env` + `permissions` for the running instance.

### Step 9: Harden `docker-compose.yml`

Already done — explicit `environment:` entries replace blanket `env_file`.

### Step 10: Update docs

**`README.md`** — replace Secrets Config section with Permissions section.
**`CLAUDE.md`** — update key patterns and enforcement layers.

### Step 11: Update tests

- `permissions.test.ts` — fixtures use `Set<string>`, config includes `permissions` section
- `env-allowlist.test.ts` — replace `secrets` config shape with `env` + `permissions`
- `mcp.test.ts` — `UserPermissions` → `Set<string>`
- `config.test.ts` — validation tests use new permission config shape

---

## Files to Modify

| File | Scope |
|------|-------|
| `src/config.ts` | `UserPermissions` → `Set<string>`, add `PermissionDef`, remove `SecretsConfig`, update parsing/validation |
| `src/claude.ts` | Rewrite `buildAllowedEnv`, update `.has()` checks, remove secrets-related code |
| `src/prompt.ts` | `.git` → `.has('git')`, `.jiraWrite` → `.has('jiraWrite')` |
| `src/mcp.ts` | `.jiraWrite` → `.has('jiraWrite')` |
| `src/core/engine.ts` | Type adaptation |
| `config.example.yaml` | New `env` + `permissions` shape |
| `config.yaml` | New `env` + `permissions` for running instance |
| `docker-compose.yml` | Already done — explicit env entries |
| `README.md` | Permissions docs |
| `CLAUDE.md` | Architecture notes |
| `src/__tests__/permissions.test.ts` | Adapt to `Set<string>` |
| `src/__tests__/env-allowlist.test.ts` | Adapt to new config shape |
| `src/__tests__/mcp.test.ts` | Adapt to `Set<string>` |
| `src/__tests__/config.test.ts` | Validation tests for new permission config |

**Not changed:** `src/queue.ts`, `src/tempdir.ts`, `src/sync-repos.ts`, `src/adapters/` — they don't touch permissions.

---

## Verification

1. **Type check**: `make server-typecheck` — no errors
2. **Tests**: `make server-test` — all existing + updated tests pass
3. **Manual smoke test**: Log `Object.keys(env)` in `buildAllowedEnv`, send a Slack message, verify only expected vars appear
4. **Denylist regression**: Confirm `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DEEPGRAM_API_KEY` (when not in a permission) do NOT appear in subprocess env
5. **Permission-linked**: User with `langfuse` sees `LANGFUSE_SECRET_KEY`; user without does not
6. **Persistent restart**: Change user permissions in config, send message, verify process restart log
7. **Persistent restart (user identity)**: Send message as user A, then user B (same perms), verify process restarts
