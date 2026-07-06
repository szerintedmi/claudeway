import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cleanupStaleTempDirs,
  resolveSessionTempDir,
  resolveIncomingDir,
  envTmpDir,
  drainAttachmentManifest,
  readAttachmentManifest,
  ATTACHMENTS_FILE,
  LAST_USED_MARKER,
} from '../tempdir.js';

function createTestRoot(): string {
  return mkdtempSync(join(tmpdir(), 'claudeway-cleanup-test-'));
}

/** Set file/dir mtime to N days ago */
function setAge(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
}

const SESSION = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('resolveSessionTempDir', () => {
  let root: string;
  beforeEach(() => {
    root = createTestRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates incoming/ and tmp/ and touches the .last-used marker', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    expect(dir).toBe(join(root, 'C001', SESSION));
    expect(existsSync(resolveIncomingDir(dir))).toBe(true);
    expect(existsSync(envTmpDir(dir))).toBe(true);
    expect(existsSync(join(dir, LAST_USED_MARKER))).toBe(true);
  });

  it('sanitizes a hostile channelId so it cannot escape the base dir', () => {
    const dir = resolveSessionTempDir(root, '../../etc', SESSION);
    // `..` collapsed + separators filtered → stays under root
    expect(dir.startsWith(root)).toBe(true);
    expect(dir).not.toContain('..');
    expect(existsSync(dir)).toBe(true);
  });

  it('re-touches .last-used on a subsequent call for the same session', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    setAge(join(dir, LAST_USED_MARKER), 30);
    resolveSessionTempDir(root, 'C001', SESSION);
    const t = statSync(join(dir, LAST_USED_MARKER)).mtimeMs;
    expect(Date.now() - t).toBeLessThan(60_000);
  });
});

describe('attachment manifest', () => {
  let root: string;
  let sessionDir: string;
  beforeEach(() => {
    root = createTestRoot();
    sessionDir = resolveSessionTempDir(root, 'C001', SESSION);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('drains the manifest, leaves files on disk, and empties on a second drain', () => {
    const f1 = join(sessionDir, 'report.md');
    const f2 = join(sessionDir, 'chart.png');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    writeFileSync(join(sessionDir, ATTACHMENTS_FILE), `${f1}\n${f2}\n`);

    const drained = drainAttachmentManifest(sessionDir);
    expect(drained).toEqual([f1, f2]);
    // Manifest cleared, but the files persist
    expect(existsSync(join(sessionDir, ATTACHMENTS_FILE))).toBe(false);
    expect(existsSync(f1)).toBe(true);
    expect(existsSync(f2)).toBe(true);

    // A second drain (no new turn wrote a manifest) returns nothing — no re-upload
    expect(drainAttachmentManifest(sessionDir)).toEqual([]);
  });

  it('skips manifest entries whose file no longer exists', () => {
    const gone = join(sessionDir, 'gone.txt');
    writeFileSync(join(sessionDir, ATTACHMENTS_FILE), `${gone}\n`);
    expect(readAttachmentManifest(sessionDir)).toEqual([]);
  });
});

describe('cleanupStaleTempDirs', () => {
  let root: string;
  beforeEach(() => {
    root = createTestRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does nothing when tempMaxAgeDays is 0 or negative (disabled)', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    setAge(join(dir, LAST_USED_MARKER), 100);
    cleanupStaleTempDirs(0, root);
    expect(existsSync(dir)).toBe(true);
    cleanupStaleTempDirs(-5, root);
    expect(existsSync(dir)).toBe(true);
  });

  it('reaps a genuinely idle session past the cutoff', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    writeFileSync(join(dir, 'old.md'), 'x');
    setAge(join(dir, 'old.md'), 100);
    setAge(dir, 100);
    setAge(join(dir, LAST_USED_MARKER), 100);

    cleanupStaleTempDirs(90, root);
    expect(existsSync(dir)).toBe(false);
    // The now-empty channel dir is removed too
    expect(existsSync(join(root, 'C001'))).toBe(false);
  });

  it('keeps a session whose .last-used is recent even if its files are old (D7 active text-only session)', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    const file = join(dir, 'report.md');
    writeFileSync(file, 'x');
    // Files untouched for a long time, dir mtime old...
    setAge(file, 200);
    setAge(dir, 200);
    // ...but the marker was touched this turn (text-only turns still touch it)
    setAge(join(dir, LAST_USED_MARKER), 1);

    cleanupStaleTempDirs(90, root);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('keeps a recent session', () => {
    const dir = resolveSessionTempDir(root, 'C001', SESSION);
    setAge(join(dir, LAST_USED_MARKER), 10);
    cleanupStaleTempDirs(90, root);
    expect(existsSync(dir)).toBe(true);
  });

  it('falls back to dir mtime when the marker is missing', () => {
    const dir = join(root, 'C001', SESSION);
    mkdirSync(dir, { recursive: true });
    setAge(dir, 100);
    cleanupStaleTempDirs(90, root);
    expect(existsSync(dir)).toBe(false);
  });

  it('leaves legacy non-UUID dirs (e.g. scratch/<channelId>) untouched', () => {
    const scratch = join(root, 'scratch', 'C001');
    mkdirSync(scratch, { recursive: true });
    const f = join(scratch, 'report.md');
    writeFileSync(f, 'x');
    // Recently modified file, but a stale containing-dir mtime — the old
    // per-session GC would wrongly delete this; the UUID-leaf filter must not.
    setAge(f, 10);
    setAge(scratch, 200);
    setAge(join(root, 'scratch'), 200);

    cleanupStaleTempDirs(90, root);
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(f)).toBe(true);
  });

  it('handles a non-existent base dir gracefully', () => {
    expect(() => cleanupStaleTempDirs(90, join(root, 'nope'))).not.toThrow();
  });
});
