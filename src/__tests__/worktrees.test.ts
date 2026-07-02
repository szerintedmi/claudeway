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
  // Strip git-hook context env (exported when the suite runs under pre-commit)
  // so test git calls aren't redirected — mirrors the production git() helper.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return execFileSync('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  git(['init', '-b', 'main', repo], base);
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

  it('fetches and bases a new worktree on origin/<branch> when the remote is ahead', () => {
    // Give the repo an origin that has moved ahead of the local checkout
    const origin = join(base, 'origin.git');
    git(['clone', '--bare', repo, origin], base);
    git(['remote', 'add', 'origin', origin], repo);
    const scratch = join(base, 'scratch');
    git(['clone', origin, scratch], base);
    git(['config', 'user.email', 'test@test'], scratch);
    git(['config', 'user.name', 'Test'], scratch);
    writeFileSync(join(scratch, 'newer.txt'), 'ahead\n');
    git(['add', '.'], scratch);
    git(['commit', '-m', 'ahead'], scratch);
    git(['push', 'origin', 'main'], scratch);

    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    expect(existsSync(join(dir!, 'newer.txt'))).toBe(true);
    // The main checkout itself is not advanced by worktree creation
    expect(existsSync(join(repo, 'newer.txt'))).toBe(false);
  });

  it('bases a new worktree on local HEAD when there is no origin remote', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    expect(git(['rev-parse', 'HEAD'], dir!)).toBe(git(['rev-parse', 'HEAD'], repo));
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

  it('keeps a stale worktree with uncommitted changes', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    writeFileSync(join(dir!, 'wip.txt'), 'unsaved work\n');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir!, '.claudeway-last-used'), old, old);

    cleanupStaleWorktrees(config, 14, opts());

    expect(existsSync(dir!)).toBe(true);
    expect(git(['branch', '--list', 'wt/C001/*'], repo)).toContain('wt/C001/111.1');
  });

  it('keeps a stale worktree whose branch has unmerged commits', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    writeFileSync(join(dir!, 'committed.txt'), 'thread work\n');
    git(['add', 'committed.txt'], dir!);
    git(['commit', '-m', 'thread work'], dir!);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir!, '.claudeway-last-used'), old, old);

    cleanupStaleWorktrees(config, 14, opts());

    expect(existsSync(dir!)).toBe(true);
    expect(git(['branch', '--list', 'wt/C001/*'], repo)).toContain('wt/C001/111.1');
  });

  it('does nothing when maxAgeDays is 0', () => {
    const dir = ensureThreadWorktree('myrepo', 'C001', '111.1', opts());
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir!, '.claudeway-last-used'), old, old);
    cleanupStaleWorktrees(config, 0, opts());
    expect(existsSync(dir!)).toBe(true);
  });
});
