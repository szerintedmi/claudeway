# User Roles & Read-Only Default

## Context

All users talking to the Claudeway bot currently share the bot owner's credentials — Claude token, Git SSH keys, and Jira API token. Per-user Claude token support is planned as a follow-up feature. Until then, only add users who already have their own Claude Max subscription to stay compliant with Anthropic's Terms of Service.

This spec addresses the Git and Jira credential isolation: ensuring teammates can interact with the bot in read-only mode without committing code or modifying Jira tickets under the owner's identity.

## Goal

Per-user, per-channel role system. **Every user is read-only by default.** Permissions are additive — the bot owner can grant specific capabilities (`git`, `jiraWrite`). The `botOwner` always has full access implicitly.

## Config Format

`allowedUsers` changes from a plain string array to a mixed list supporting both plain user IDs (read-only) and user-ID-to-permissions mappings:

```yaml
channels:
  C0EXAMPLE01:
    name: team-project
    repo: my-project
    allowedUsers:
      - "U0ADMIN001": [git, jiraWrite]  # Alice - full access
      - "U0DEV00002": [git]              # Bob - git access, Jira read-only
      - "U0VIEW0003"                     # Carol - read-only
      - "U0VIEW0004"                     # Dave - read-only
```

- Plain string → read-only (default)
- String with array → read-only + listed additive permissions
- `botOwner` → always full access regardless of listing

### Permissions

| Permission   | What it grants |
|-------------|----------------|
| `git`       | Git credentials available (push/commit), file modification allowed in system prompt |
| `jiraWrite` | Uses full MCP config (`mcp.json`) instead of read-only MCP config |

## Trust Model

Read-only mode is designed for **trusted teammates** as a guard against accidental changes — not as a security sandbox against adversarial users. The system prompt layer is advisory (Claude follows it reliably but a determined user could attempt prompt injection). The git credential stripping and MCP read-only layers provide hard enforcement.

## Enforcement Layers

Three layers enforce read-only behavior. Layers 2–4 are hard enforcement; Layer 1 is a soft guard that provides UX and catches intent.

### 1. System Prompt Injection

For read-only users (or users without specific permissions), append restrictions to the system prompt before passing to Claude CLI:

```
## Access restrictions for this user

You are operating in READ-ONLY mode for this user.
- Do NOT modify, create, or delete any files in the repository
- Do NOT run git commit, git push, git checkout, git stash, or any git commands that modify state
- Do NOT create, update, or delete Jira tickets or Confluence pages
- You MAY read files, search code, run git log/diff/show, and search Jira/Confluence
- You MAY write files to $CLAUDEWAY_SCRATCH_DIR — this is a shared workspace that persists across messages in this channel
- You MAY write temporary files to $CLAUDEWAY_TEMP_DIR for one-off outputs (e.g., file attachments)
- If the user asks you to do something restricted, explain that they have read-only access
```

**Scratch directory**: A per-channel persistent directory at `.claudeway-tmp/scratch/<channelId>/` exposed as `$CLAUDEWAY_SCRATCH_DIR`. Unlike the per-request `$CLAUDEWAY_TEMP_DIR` (which is ephemeral), the scratch dir persists across messages so multi-turn workflows work — e.g., Alice asks Claude to draft a report, Bob asks to tweak it. All users in the channel share the same scratch dir. This is particularly important for read-only users who can't write to the repo itself.

When `git` permission is granted, the git/file restrictions are removed. When `jiraWrite` is granted, the Jira/Confluence write restrictions are removed.

### 2. Git Credential Stripping

For users **without** `git` permission, inject env vars that disable all git authentication:

```typescript
function buildGitReadOnlyEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',           // No interactive prompts
    GIT_ASKPASS: '/bin/false',           // Block password requests
    GIT_SSH_COMMAND: '/bin/false',       // SSH completely disabled
    GIT_CONFIG_GLOBAL: '/dev/null',      // Ignore global git config
    GIT_CONFIG_SYSTEM: '/dev/null',      // Ignore system git config
    GIT_CONFIG_NOSYSTEM: '1',            // Confirm no system config
    SSH_AUTH_SOCK: '',                   // Disable SSH agent forwarding
    SSH_AGENT_PID: '',                   // Disable SSH agent
  };
}
```

Effect: `git push`, `git clone` (authenticated), and any credential-based operations fail immediately. SSH agent socket is cleared to prevent bypassing `GIT_SSH_COMMAND` via direct `ssh` calls. Local reads (`git log`, `git diff`, `git show`) still work.

### 3. Git Author Identity

For **all** users (including those with `git` permission), set git author env vars from the Slack user's profile. This ensures commits are attributed correctly even when using a shared SSH key:

```typescript
function buildGitAuthorEnv(userName: string, channelName: string): Record<string, string> {
  const email = `${userName.toLowerCase().replace(/\s+/g, '.')}@${channelName}.slack`;
  return {
    GIT_AUTHOR_NAME: userName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: userName,
    GIT_COMMITTER_EMAIL: email,
  };
}
```

The display name is resolved from the Slack API via `resolveUserDirectory()` at enqueue time. Since `QueuedMessage` currently has no `userName` field, add `userName?: string` to `QueuedMessage` and populate it in `registerMessageHandler` so it's available at processing time without a re-fetch.

### 4. MCP Read-Only Config

Generate a read-only MCP config file alongside the existing `mcp.json`. For users **without** `jiraWrite` permission, pass `--mcp-config mcp-readonly.json` to Claude CLI.

The read-only config is a copy of `mcp.json` with `READ_ONLY_MODE: "true"` injected into the `env` of each MCP server entry that supports it (mcp-atlassian does natively).

**Generation**: On startup (or when `mcp.json` is detected), auto-generate `mcp-readonly.json` by reading and transforming `mcp.json`. This avoids manual maintenance of two config files.

## Persistent Process Mode

In persistent mode, a single long-lived Claude process serves all users in a channel. The env vars, MCP config, and system prompt are set at spawn time, not per-message.

**Problem**: If an admin starts the persistent process, then a read-only user sends a message, that message runs with the admin's full permissions.

**Solution**: Track the current permission level on the persistent process registry entry. When a message arrives from a user with a **different permission set** than the currently running process:

1. Kill the existing persistent process
2. **Await the `close` event** before proceeding — the kill is async (`SIGTERM`), and the old process must fully exit and flush its session `.jsonl` before the replacement can safely `--resume`
3. Respawn with the new user's env vars, MCP config, and system prompt
4. Use `--resume <sessionId>` to preserve conversation context

No restart is needed when users with the **same permission set** alternate (e.g., two read-only users).

The permission set for comparison is the sorted, serialized permissions array (e.g., `""`, `"git"`, `"git,jiraWrite"`).

## Implementation Plan

### Phase 1: Config Parsing -- DONE

**File: `src/config.ts`**

- [x] Update `ChannelConfig.allowedUsers` type from `string[]` to `AllowedUserEntry[]`
- [x] Add `UserPermissions` type, `FULL_PERMISSIONS`, `READ_ONLY_PERMISSIONS` constants
- [x] Add `parseAllowedUsers(entries)` → returns `Map<string, UserPermissions>` normalizing both formats
- [x] **Validate permission strings** in `loadConfig()` — unknown permissions (e.g., typo `jireWrite`) throw a clear error at startup
- [x] Add `resolveUserPermissions(config, channelId, userId)` → returns `UserPermissions` (botOwner gets all true)
- [x] Add `permissionKey(permissions)` → stable string key for comparison (e.g., `""`, `"git"`, `"git,jiraWrite"`)
- [x] Update `isUserAllowed()` in `src/adapters/slack/utils.ts` (moved from `src/slack-utils.ts` in Phase 0 modularization) to extract user IDs from the new mixed format (both string and object entries)
- [x] **Fix `botOwner` message-level bypass**: added `botOwner` check before `isUserAllowed` in `registerMessageHandler` so `botOwner` can message any configured channel even if not listed in `allowedUsers`

### Phase 2: Git Env Injection -- DONE

**File: `src/claude.ts`**

- [x] Add `buildGitReadOnlyEnv()` helper — disables git auth via env vars
- [x] Add `buildGitAuthorEnv(userName, channelName)` helper — sets GIT_AUTHOR/COMMITTER_NAME/EMAIL
- [x] Add `buildPermissionsEnv(options)` — composes git author + credential stripping + scratch dir
- [x] Inject permission env in both `spawnClaudeProcess()` (via `buildExtraEnv`) and `createPersistentProcess()`

### Phase 3: Per-Channel Scratch Directory -- DONE

**File: `src/tempdir.ts`**

- [x] Add `ensureScratchDir(baseDir, channelId)` → creates and returns `.claudeway-tmp/scratch/<channelId>/`
- [x] `CLAUDEWAY_SCRATCH_DIR` env var set on subprocess via `buildPermissionsEnv()`
- [x] Scratch dir persists across messages (unlike per-request temp dir)

### Phase 4: MCP Read-Only Config -- DONE

**File: `src/mcp.ts` (new)**

- [x] Add `generateReadOnlyMcpConfig(sourcePath)` → reads `mcp.json`, injects `READ_ONLY_MODE: "true"` into each server's env, writes `mcp-readonly.json`
- [x] Called on startup in `src/index.ts` if `mcp.json` exists
- [x] Add `getMcpConfigPath(permissions, cwd)` — selects `mcp.json` or `mcp-readonly.json` based on `jiraWrite`
- [x] Hard enforcement: non-jiraWrite users get `null` (no MCP) rather than falling back to full `mcp.json` when readonly config is missing
- [x] Both `buildClaudeArgs()` and `buildPersistentClaudeArgs()` use `getMcpConfigPath()`

### Phase 5: System Prompt Injection -- DONE

**File: `src/prompt.ts`**

- [x] Add `buildAccessRestrictions(permissions, scratchDir)` → returns restriction text or empty string
- [x] Add `appendAccessRestrictions(systemPrompt, permissions, scratchDir)` → convenience wrapper
- [x] Integrated in `processQueuedMessage()` — restrictions appended to system prompt before passing to Claude

### Phase 6: Persistent Process Permission Tracking -- DONE

**File: `src/claude.ts`**

- [x] Add `permissionKey: string` field to `PersistentProcessEntry`
- [x] On message arrival in `runClaudePersistentStreaming()`, compare incoming permission key with running process
- [x] If different, gracefully resolve stale `currentTurn`, then `killAndWait()` (SIGTERM → 5s → SIGKILL), respawn with `--resume`
- [x] If same, proceed normally (send message to stdin)

### Phase 7: Wire Up -- DONE

**File: `src/queue.ts`**

- [x] Add `userName?: string` field to `QueuedMessage` (backward compatible)

**Files: `src/adapters/slack/handler.ts` + `src/core/engine.ts`** (split from `src/slack.ts` in Phase 0 modularization)

- [x] In `registerMessageHandler` (now `src/adapters/slack/handler.ts`), extract `userName` from `resolveUserDirectory()` result, add to `enqueue()` call
- [x] In `processQueuedMessage()` (now `src/core/engine.ts`), resolve permissions via `resolveUserPermissions()`, create scratch dir, append access restrictions to system prompt
- [x] Pass `PermissionContext` (userPermissions, userName, channelName, scratchDir) through to Claude spawn

### Phase 8: Documentation & Config Migration -- DONE

- [x] Update `CLAUDE.md` with the new permission model
- [x] Update `config.yaml` to use the new format for existing users
- [x] Add `mcp-readonly.json` to `.gitignore` (auto-generated)
- [x] Add inline comments to `config.example.yaml`

### Phase 9: Tests -- DONE

**File: `src/__tests__/permissions.test.ts` (new, 37 tests)**

- [x] `parseAllowedUsers()` — plain strings, objects, mixed, empty array, empty permissions array
- [x] `extractAllowedUserIds()` — plain, object, mixed entries
- [x] `resolveUserPermissions()` — botOwner override, channel-specific, missing user, open channel, unknown channel
- [x] `permissionKey()` — all combos including undefined
- [x] `isUserAllowed()` — mixed format, undefined, empty
- [x] `buildAccessRestrictions()` — all permission combos, scratch dir inclusion
- [x] `appendAccessRestrictions()` — passthrough for full, appends for restricted

**File: `src/__tests__/mcp.test.ts` (new, 10 tests)**

- [x] `generateReadOnlyMcpConfig()` — env injection, no-env servers, multiple servers, field preservation
- [x] `getMcpConfigPath()` — jiraWrite true/false, missing files, fallback behavior, undefined permissions

**File: `src/__tests__/config.test.ts` (2 new tests)**

- [x] Rejects unknown permissions in `loadConfig()` validation
- [x] Accepts valid permissions

## Files Created/Modified

| File | Action | Status | Description |
|------|--------|--------|-------------|
| `src/config.ts` | Modify | DONE | New types, `parseAllowedUsers()`, `resolveUserPermissions()`, `permissionKey()`, validation |
| `src/adapters/slack/utils.ts` | Modify | DONE | `isUserAllowed()` supports mixed `AllowedUserEntry[]` format (moved from `src/slack-utils.ts`) |
| `src/queue.ts` | Modify | DONE | `userName?: string` on `QueuedMessage` |
| `src/claude.ts` | Modify | DONE | Git env helpers, `buildPermissionsEnv()`, `ClaudeOptions` extensions, persistent process `permissionKey` tracking, `killAndWait()` |
| `src/tempdir.ts` | Modify | DONE | `ensureScratchDir()` |
| `src/mcp.ts` | Create | DONE | `generateReadOnlyMcpConfig()`, `getMcpConfigPath()` |
| `src/prompt.ts` | Modify | DONE | `buildAccessRestrictions()`, `appendAccessRestrictions()` |
| `src/adapters/slack/handler.ts` | Modify | DONE | botOwner bypass, userName extraction (split from `src/slack.ts`) |
| `src/core/engine.ts` | Modify | DONE | Permission resolution in `processQueuedMessage`, PermissionContext (split from `src/slack.ts`) |
| `src/adapters/slack/index.ts` | Modify | DONE | MCP readonly config generation at startup (moved from `src/index.ts`) |
| `src/__tests__/permissions.test.ts` | Create | DONE | 37 tests |
| `src/__tests__/mcp.test.ts` | Create | DONE | 10 tests |
| `src/__tests__/config.test.ts` | Modify | DONE | 2 new validation tests |
| `config.yaml` | Modify | TODO | Migrate to new allowedUsers format |
| `CLAUDE.md` | Modify | TODO | Document new permission model |
