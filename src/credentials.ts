import { credentialExposeAs, credentialFields, type Config } from './config.js';
import { getSecretStore, hashSecretValues, type SecretStore } from './secrets.js';

/**
 * Registry-driven per-user credential resolution.
 *
 * Resolution precedence per credential: user secret > explicit shared default
 * (from `defaultFromEnv`) > unset. Provider token scope controls whether a
 * resolved credential can read or write.
 */

/** Username sent with a GitHub PAT over HTTPS basic auth (any non-empty value works). */
export const GIT_CREDENTIAL_USERNAME = 'x-access-token';

export interface GitCredentialResolution {
  token: string;
  username: string;
  source: 'user' | 'shared';
  /** Stable key for reusing the generated helper files across spawns. */
  cacheKey: string;
}

/** Per-credential resolution outcome — feeds the agent-facing prompt block. */
export interface CredentialStatus {
  name: string;
  label: string;
  source: 'personal' | 'shared' | 'none';
  /** Config-declared capability note for the shared default (sharedAccessNote). */
  note?: string;
}

export interface ResolvedCredentials {
  /** Env vars to inject at highest precedence (personal or explicit shared default values). */
  env: Record<string, string>;
  /** Resolved git token for the credential-helper adapter (never enters subprocess env). */
  git: GitCredentialResolution | null;
  /** Every resolved secret value — for scrubbing stderr/error output. */
  secretValues: string[];
  /** Cred names resolved from the user's personal store (audit). */
  personalCredNames: string[];
  /** Cred names where the explicit shared default was used (audit). */
  sharedCredNames: string[];
  /** Resolution outcome per registry credential, in registry order. */
  statuses: CredentialStatus[];
  /**
   * MCP servers to force into read-only mode for this user — union of
   * `mcpReadOnlyServers` over credentials that did NOT resolve to a personal
   * secret (sorted, deduped). Feeds getMcpConfigPath and the process identity.
   */
  readOnlyMcpServers: string[];
  /**
   * True when `userCredentials.claude` is configured but no Claude token
   * resolved for this user. Hard gate: the engine refuses the turn instead of
   * letting the subprocess inherit the owner's ~/.claude auth.
   */
  missingClaudeCred: boolean;
  /** Stable hash over resolved values for persistent-process identity. */
  secretsHash: string;
}

const EMPTY: ResolvedCredentials = {
  env: {},
  git: null,
  secretValues: [],
  personalCredNames: [],
  sharedCredNames: [],
  statuses: [],
  readOnlyMcpServers: [],
  missingClaudeCred: false,
  secretsHash: '',
};

/** Whether the git credential-helper adapter is configured. */
export function gitCredConfigured(config: Config): boolean {
  return Object.values(config.userCredentials ?? {}).some(
    (def) => credentialExposeAs(def) === 'git-credential-helper',
  );
}

export function resolveUserCredentials(
  config: Config,
  userId: string,
  opts: { store?: SecretStore } = {},
): ResolvedCredentials {
  const registry = config.userCredentials;
  if (!registry || Object.keys(registry).length === 0) return { ...EMPTY };

  const store = opts.store ?? getSecretStore();
  const result: ResolvedCredentials = {
    env: {},
    git: null,
    secretValues: [],
    personalCredNames: [],
    sharedCredNames: [],
    statuses: [],
    readOnlyMcpServers: [],
    missingClaudeCred: false,
    secretsHash: '',
  };
  // Values that feed the identity hash (name-scoped so renames also respawn)
  const hashInput: Record<string, string> = {};

  for (const [credName, def] of Object.entries(registry)) {
    const exposeAs = credentialExposeAs(def);
    const fields = credentialFields(def);
    const personal = store.get(userId, credName);
    let source: CredentialStatus['source'] = 'none';

    if (exposeAs === 'git-credential-helper') {
      const tokenField = fields[0];
      if (tokenField && personal?.[tokenField.name]) {
        const token = personal[tokenField.name];
        result.git = {
          token,
          username: GIT_CREDENTIAL_USERNAME,
          source: 'user',
          cacheKey: `${userId}|${credName}`,
        };
        result.secretValues.push(token);
        result.personalCredNames.push(credName);
        hashInput[`${credName}.${tokenField.name}`] = token;
        source = 'personal';
      } else if (tokenField?.def.defaultFromEnv && process.env[tokenField.def.defaultFromEnv]) {
        const token = process.env[tokenField.def.defaultFromEnv]!;
        result.git = {
          token,
          username: GIT_CREDENTIAL_USERNAME,
          source: 'shared',
          cacheKey: `shared|${credName}`,
        };
        result.secretValues.push(token);
        result.sharedCredNames.push(credName);
        hashInput[`${credName}.${tokenField.name}`] = token;
        source = 'shared';
      }
    } else {
      // Plain env injection
      if (personal) {
        for (const field of fields) {
          if (personal[field.name]) {
            result.env[field.name] = personal[field.name];
            result.secretValues.push(personal[field.name]);
            hashInput[`${credName}.${field.name}`] = personal[field.name];
            source = 'personal';
          }
        }
        if (source === 'personal') result.personalCredNames.push(credName);
      }

      if (source === 'none') {
        for (const field of fields) {
          if (field.def.defaultFromEnv && process.env[field.def.defaultFromEnv]) {
            result.env[field.name] = process.env[field.def.defaultFromEnv]!;
            result.secretValues.push(process.env[field.def.defaultFromEnv]!);
            hashInput[`${credName}.${field.name}`] = process.env[field.def.defaultFromEnv]!;
            source = 'shared';
          }
        }
        if (source === 'shared') result.sharedCredNames.push(credName);
      }
    }

    result.statuses.push({
      name: credName,
      label: def.label,
      source,
      ...(source === 'shared' && def.sharedAccessNote ? { note: def.sharedAccessNote } : {}),
    });

    // Shared full-access tokens (Atlassian tokens can't be scoped) get their
    // MCP servers forced read-only; only a personal secret unlocks writes.
    if (def.mcpReadOnlyServers?.length && source !== 'personal') {
      result.readOnlyMcpServers.push(...def.mcpReadOnlyServers);
    }
  }

  result.readOnlyMcpServers = [...new Set(result.readOnlyMcpServers)].sort();

  // BYO Claude is always on: every user (bot owner included) must run on
  // their own token — otherwise the subprocess would silently inherit the
  // owner's ~/.claude auth. The claude entry is built-in (loadConfig).
  result.missingClaudeCred = !result.personalCredNames.includes('claude');

  result.secretsHash = hashSecretValues(hashInput);
  return result;
}
