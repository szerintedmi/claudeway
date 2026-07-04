import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Per-user credential store. Keyed by CANONICAL user id (users: registry key),
 * so a person's Slack and voice turns resolve the same credentials.
 *
 * A credential value is a map of env var name → secret value (e.g. Jira stores
 * both JIRA_USERNAME and JIRA_API_TOKEN under the single name "jira").
 */
export interface SecretStore {
  set(userId: string, name: string, value: Record<string, string>): void;
  /** Decrypt one credential. Returns null when absent. */
  get(userId: string, name: string): Record<string, string> | null;
  /** Decrypt all credentials for a user. */
  getAll(userId: string): Record<string, Record<string, string>>;
  /** Delete one credential (or all when name is omitted). Returns true if something was removed. */
  delete(userId: string, name?: string): boolean;
  /** Credential names only — never values. */
  listNames(userId: string): string[];
  /** Enrolled user ids (for offboarding). */
  listUsers(): string[];
}

interface EncryptedEntry {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
}

interface StoreFile {
  version: 1;
  users: Record<string, Record<string, EncryptedEntry>>;
}

export const SECRETS_DIR = '.secrets';
const STORE_FILE = 'user-credentials.json';
const KEY_FILE = 'key';
const KEY_ENV_VAR = 'CLAUDEWAY_SECRETS_KEY';

export function secretsDir(baseDir: string = process.cwd()): string {
  return resolve(baseDir, SECRETS_DIR);
}

/**
 * Load the AES-256 master key from CLAUDEWAY_SECRETS_KEY (hex or base64)
 * or from the gitignored `.secrets/key` file. Returns null when unset —
 * credential features must refuse to operate without it.
 */
export function loadMasterKey(baseDir: string = process.cwd()): Buffer | null {
  const fromEnv = process.env[KEY_ENV_VAR];
  if (fromEnv) {
    const key = parseKey(fromEnv.trim());
    if (!key) {
      throw new Error(`${KEY_ENV_VAR} must be 32 bytes, hex or base64 encoded`);
    }
    return key;
  }
  const keyPath = join(secretsDir(baseDir), KEY_FILE);
  if (existsSync(keyPath)) {
    const key = parseKey(readFileSync(keyPath, 'utf-8').trim());
    if (!key) {
      throw new Error(`${keyPath} must contain a 32-byte key, hex or base64 encoded`);
    }
    return key;
  }
  return null;
}

function parseKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    // fall through
  }
  return null;
}

/** Generate a fresh master key (hex) — for setup docs / scripts. */
export function generateMasterKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * AES-256-GCM file-backed SecretStore. Atomic temp+validate+rename writes,
 * chmod 600 on the store file. Drop-in replaceable by a keychain/KMS backend.
 */
export class FileSecretStore implements SecretStore {
  private readonly storePath: string;
  private readonly key: Buffer;

  constructor(key: Buffer, baseDir: string = process.cwd()) {
    if (key.length !== 32) throw new Error('FileSecretStore requires a 32-byte key');
    this.key = key;
    const dir = secretsDir(baseDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.storePath = join(dir, STORE_FILE);
  }

  private load(): StoreFile {
    if (!existsSync(this.storePath)) return { version: 1, users: {} };
    const parsed = JSON.parse(readFileSync(this.storePath, 'utf-8')) as StoreFile;
    if (parsed.version !== 1 || typeof parsed.users !== 'object' || parsed.users === null) {
      throw new Error(`Unrecognized secret store format at ${this.storePath}`);
    }
    return parsed;
  }

  private save(store: StoreFile): void {
    const tmpPath = this.storePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Validate the temp file parses before replacing the store
    const parsed = JSON.parse(readFileSync(tmpPath, 'utf-8')) as StoreFile;
    if (parsed.version !== 1) throw new Error('secret store validation failed');
    renameSync(tmpPath, this.storePath);
    chmodSync(this.storePath, 0o600);
  }

  private encrypt(value: Record<string, string>): EncryptedEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(entry: EncryptedEntry): Record<string, string> {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'base64')),
      decipher.final(), // throws on tampered ciphertext/tag
    ]);
    return JSON.parse(plaintext.toString('utf-8')) as Record<string, string>;
  }

  set(userId: string, name: string, value: Record<string, string>): void {
    const store = this.load();
    store.users[userId] = store.users[userId] ?? {};
    store.users[userId][name] = this.encrypt(value);
    this.save(store);
  }

  get(userId: string, name: string): Record<string, string> | null {
    const entry = this.load().users[userId]?.[name];
    return entry ? this.decrypt(entry) : null;
  }

  getAll(userId: string): Record<string, Record<string, string>> {
    const entries = this.load().users[userId] ?? {};
    const out: Record<string, Record<string, string>> = {};
    for (const [name, entry] of Object.entries(entries)) {
      out[name] = this.decrypt(entry);
    }
    return out;
  }

  delete(userId: string, name?: string): boolean {
    const store = this.load();
    const user = store.users[userId];
    if (!user) return false;
    if (name === undefined) {
      delete store.users[userId];
      this.save(store);
      return true;
    }
    if (!(name in user)) return false;
    delete user[name];
    if (Object.keys(user).length === 0) delete store.users[userId];
    this.save(store);
    return true;
  }

  listNames(userId: string): string[] {
    return Object.keys(this.load().users[userId] ?? {}).sort();
  }

  listUsers(): string[] {
    return Object.keys(this.load().users).sort();
  }
}

let cachedStore: SecretStore | undefined;

/**
 * Process-wide secret store singleton. The master key is mandatory — per-user
 * credentials are always on (BYO Claude). Throws when no key is configured;
 * startup calls this first so a missing key fails fast instead of limping
 * along in a half-configured state.
 */
export function getSecretStore(baseDir: string = process.cwd()): SecretStore {
  if (cachedStore !== undefined) return cachedStore;
  const key = loadMasterKey(baseDir);
  if (!key) {
    throw new Error(
      `[secrets] master key required: set ${KEY_ENV_VAR} or create ${SECRETS_DIR}/${KEY_FILE} ` +
        `(generate with: openssl rand -hex 32)`,
    );
  }
  cachedStore = new FileSecretStore(key, baseDir);
  return cachedStore;
}

/** Test hook — reset the singleton. */
export function resetSecretStoreForTests(): void {
  cachedStore = undefined;
}

/**
 * Replace every occurrence of the given secret values in a string with
 * [redacted]. Used on stderr/error text before it is logged or surfaced.
 */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (!value || value.length < 4) continue; // avoid mangling text on trivial values
    out = out.split(value).join('[redacted]');
  }
  return out;
}

/** Stable hash over resolved secret values — for process identity keys. Never log values. */
export function hashSecretValues(env: Record<string, string>): string {
  const pairs = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  if (!pairs) return '';
  return createHash('sha256').update(pairs).digest('hex').slice(0, 16);
}

/** Constant-time string comparison for token checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
