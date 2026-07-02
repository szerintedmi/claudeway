import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  ensureThreadWorktree,
  cleanupStaleWorktrees,
  threadWorktreePath,
  threadWorktreeBranch,
} from '../worktrees.js';
import type { Config } from '../config.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

let base: string;
let repo: string;
let wtBase: string;

const config: Config = {
  channels: {},
  defaults: { model: 'opus', systemPrompt: 's', timeoutMs: 1000, responseMode: 'batch' },
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'claudeway-wt-test-'));
  repo = join(base, 'repo');
  wtBase = join(base, 'worktrees');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(['config', 'user.email', 'test@test'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'file.txt'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const opts = () => ({ repoFolder: repo, worktreesBase: wtBase });

describe('ensureThreadWorktree', () => {
  it('lazily creates a worktree on branch wt/<channel>/<threadTs>', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '1735730000.123456', opts());
    expect(dir).toBe(threadWorktreePath('myrepo', 'C001', '1735730000.123456', wtBase));
    expect(existsSync(join(dir!, 'file.txt'))).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir!)).toBe(
      threadWorktreeBranch('C001', '1735730000.123456'),
    );
  });

  it('reuses the worktree for subsequent turns in the thread', () => {
    const dir1 = ensureThreadWorktree('myrepo', 'C001', '111.222', opts());
    writeFileSync(join(dir1!, 'scratch.txt'), 'turn one\n');
    const dir2 = ensureThreadWorktree('myrepo', 'C001', '111.222', opts());
    expect(dir2).toBe(dir1);
    expect(existsSync(join(dir2!, 'scratch.txt'))).toBe(true);
  });

  it('isolates concurrent threads on the same repo', () => {
    const a = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    const b = ensureThreadWorktree('myrepo', 'C001', '222.2', opts());
    expect(a).not.toBe(b);
    writeFileSync(join(a!, 'only-a.txt'), 'a\n');
    expect(existsSync(join(b!, 'only-a.txt'))).toBe(false);
  });

  it('returns null when the repo folder is not a git repo (fallback to main checkout)', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', {
      repoFolder: join(base, 'not-a-repo'),
      worktreesBase: wtBase,
    });
    expect(dir).toBeNull();
  });

  it('recreates a worktree whose branch survived a previous prune', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    // Simulate a dir wipe without `git worktree remove`
    rmSync(dir!, { recursive: true, force: true });
    const again = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    expect(again).toBe(dir);
    expect(existsSync(join(again!, 'file.txt'))).toBe(true);
  });
});

describe('threadWorktreePath', () => {
  it('sanitizes path-traversal attempts in channel/thread ids', () => {
    const p = threadWorktreePath('repo', '../../etc', '..%2f..', wtBase);
    expect(p.startsWith(wtBase)).toBe(true);
    expect(p).not.toContain('..');
  });
});

describe('cleanupStaleWorktrees', () => {
  it('prunes worktrees (and their branches) idle past the max age, keeps fresh ones', () => {
    const stale = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    const fresh = ensureThreadWorktree('myrepo', 'C001', '222.2', opts());

    // Age the stale worktree's marker beyond the cutoff
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(stale!, '.claudeway-last-used'), old, old);

    cleanupStaleWorktrees(config, 14, opts());

    expect(existsSync(stale!)).toBe(false);
    expect(existsSync(fresh!)).toBe(true);
    const branches = git(['branch', '--list', 'wt/C001/*'], repo);
    expect(branches).not.toContain('wt/C001/111.1');
    expect(branches).toContain('wt/C001/222.2');
  });

  it('does nothing when maxAgeDays is 0', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir!, '.claudeway-last-used'), old, old);
    cleanupStaleWorktrees(config, 0, opts());
    expect(existsSync(dir!)).toBe(true);
  });
});
