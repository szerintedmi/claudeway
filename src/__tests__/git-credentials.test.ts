import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildGitConfig,
  ensureGitCredentialFiles,
  cleanupGitCredentialFiles,
  gitCredentialsDir,
} from '../git-credentials.js';
import type { GitCredentialResolution } from '../credentials.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudeway-gitcred-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cred: GitCredentialResolution = {
  token: 'ghp_supersecret123',
  username: 'x-access-token',
  source: 'user',
  cacheKey: 'petro|github',
};

describe('ensureGitCredentialFiles', () => {
  it('writes a gitconfig with the SSH→HTTPS rewrite and helper reference — never a token literal', () => {
    const gitconfigPath = ensureGitCredentialFiles(cred, dir);
    const content = readFileSync(gitconfigPath, 'utf-8');
    expect(content).toContain('insteadOf = git@github.com:');
    expect(content).toContain('insteadOf = ssh://git@github.com/');
    expect(content).toContain('helper = ');
    expect(content).not.toContain('ghp_supersecret123');
  });

  it('the credential file holds the token with 600 perms', () => {
    const gitconfigPath = ensureGitCredentialFiles(cred, dir);
    const credPath = gitconfigPath.replace(/\.gitconfig$/, '.cred');
    const content = readFileSync(credPath, 'utf-8');
    expect(content).toBe('username=x-access-token\npassword=ghp_supersecret123\n');
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    expect(statSync(gitconfigPath).mode & 0o777).toBe(0o600);
    // The gitconfig helper references the credential file
    expect(readFileSync(gitconfigPath, 'utf-8')).toContain(credPath);
  });

  it('reuses files for the same identity+token, regenerates on a token change', () => {
    const p1 = ensureGitCredentialFiles(cred, dir);
    const p2 = ensureGitCredentialFiles(cred, dir);
    expect(p1).toBe(p2);
    const p3 = ensureGitCredentialFiles({ ...cred, token: 'ghp_rotated' }, dir);
    expect(p3).not.toBe(p1);
  });

  it('cleanupGitCredentialFiles wipes the directory', () => {
    ensureGitCredentialFiles(cred, dir);
    expect(existsSync(gitCredentialsDir(dir))).toBe(true);
    cleanupGitCredentialFiles(dir);
    expect(existsSync(gitCredentialsDir(dir))).toBe(false);
  });
});

describe('buildGitConfig', () => {
  it('resets inherited helpers before registering ours', () => {
    const content = buildGitConfig('/tmp/x.cred');
    const helperLines = content.split('\n').filter((l) => l.includes('helper ='));
    expect(helperLines[0]!.trim()).toBe('helper =');
    expect(helperLines[1]).toContain('cat');
  });

  it('rejects paths with single quotes (shell-quoting safety)', () => {
    expect(() => buildGitConfig("/tmp/it's.cred")).toThrow();
  });
});
