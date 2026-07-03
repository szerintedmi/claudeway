import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'node:crypto';
import {
  FileSecretStore,
  loadMasterKey,
  generateMasterKey,
  scrubSecrets,
  hashSecretValues,
  safeEqual,
} from '../secrets.js';

let dir: string;
const key = randomBytes(32);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudeway-secrets-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileSecretStore', () => {
  it('round-trips a credential (AES-256-GCM)', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'tok-123', JIRA_USERNAME: 'p@x.com' });
    expect(store.get('petro', 'jira')).toEqual({
      JIRA_API_TOKEN: 'tok-123',
      JIRA_USERNAME: 'p@x.com',
    });
  });

  it('never stores plaintext values on disk', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'github', { GITHUB_TOKEN: 'ghp_supersecret' });
    const raw = readFileSync(join(dir, '.secrets', 'user-credentials.json'), 'utf-8');
    expect(raw).not.toContain('ghp_supersecret');
  });

  it('chmods the store file to 600', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'x' });
    const mode = statSync(join(dir, '.secrets', 'user-credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('detects tampering (bad auth tag)', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'tok-123' });
    const storePath = join(dir, '.secrets', 'user-credentials.json');
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
    // Flip bytes in the ciphertext
    const buf = Buffer.from(parsed.users.petro.jira.ciphertext, 'base64');
    buf[0] ^= 0xff;
    parsed.users.petro.jira.ciphertext = buf.toString('base64');
    writeFileSync(storePath, JSON.stringify(parsed), 'utf-8');
    expect(() => store.get('petro', 'jira')).toThrow();
  });

  it('rejects a wrong key', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'tok-123' });
    const other = new FileSecretStore(randomBytes(32), dir);
    expect(() => other.get('petro', 'jira')).toThrow();
  });

  it('lists names only and users for offboarding', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'a' });
    store.set('petro', 'github', { GITHUB_TOKEN: 'b' });
    store.set('val', 'claude', { CLAUDE_CODE_OAUTH_TOKEN: 'c' });
    expect(store.listNames('petro')).toEqual(['github', 'jira']);
    expect(store.listNames('nobody')).toEqual([]);
    expect(store.listUsers()).toEqual(['petro', 'val']);
  });

  it('deletes one credential or all', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'a' });
    store.set('petro', 'github', { GITHUB_TOKEN: 'b' });
    expect(store.delete('petro', 'jira')).toBe(true);
    expect(store.listNames('petro')).toEqual(['github']);
    expect(store.delete('petro')).toBe(true);
    expect(store.listUsers()).toEqual([]);
    expect(store.delete('petro')).toBe(false);
  });

  it('getAll decrypts every credential for a user', () => {
    const store = new FileSecretStore(key, dir);
    store.set('petro', 'jira', { JIRA_API_TOKEN: 'a' });
    store.set('petro', 'github', { GITHUB_TOKEN: 'b' });
    expect(store.getAll('petro')).toEqual({
      jira: { JIRA_API_TOKEN: 'a' },
      github: { GITHUB_TOKEN: 'b' },
    });
  });
});

describe('loadMasterKey', () => {
  const originalEnv = process.env.CLAUDEWAY_SECRETS_KEY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDEWAY_SECRETS_KEY;
    else process.env.CLAUDEWAY_SECRETS_KEY = originalEnv;
  });

  it('parses a hex key from the env var', () => {
    process.env.CLAUDEWAY_SECRETS_KEY = generateMasterKey();
    const k = loadMasterKey(dir);
    expect(k?.length).toBe(32);
  });

  it('parses a base64 key from the env var', () => {
    process.env.CLAUDEWAY_SECRETS_KEY = randomBytes(32).toString('base64');
    expect(loadMasterKey(dir)?.length).toBe(32);
  });

  it('throws on a malformed key', () => {
    process.env.CLAUDEWAY_SECRETS_KEY = 'too-short';
    expect(() => loadMasterKey(dir)).toThrow();
  });

  it('returns null when no key is configured', () => {
    delete process.env.CLAUDEWAY_SECRETS_KEY;
    expect(existsSync(join(dir, '.secrets', 'key'))).toBe(false);
    expect(loadMasterKey(dir)).toBeNull();
  });
});

describe('scrubSecrets', () => {
  it('redacts every occurrence of every value', () => {
    const out = scrubSecrets('token tok-123 leaked, again tok-123 and ghp_x12345', [
      'tok-123',
      'ghp_x12345',
    ]);
    expect(out).toBe('token [redacted] leaked, again [redacted] and [redacted]');
  });

  it('ignores empty and trivially short values', () => {
    expect(scrubSecrets('abc def', ['', 'ab'])).toBe('abc def');
  });
});

describe('hashSecretValues', () => {
  it('is stable across key order and changes when a value changes', () => {
    const a = hashSecretValues({ A: '1', B: '2' });
    const b = hashSecretValues({ B: '2', A: '1' });
    const c = hashSecretValues({ A: '1', B: '3' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(hashSecretValues({})).toBe('');
  });

  it('never contains the raw values', () => {
    const h = hashSecretValues({ TOKEN: 'ghp_secretvalue' });
    expect(h).not.toContain('ghp_secretvalue');
  });
});

describe('safeEqual', () => {
  it('compares strings without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
