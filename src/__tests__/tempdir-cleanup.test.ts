import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupStaleTempFiles } from '../tempdir.js';

function createTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudeway-cleanup-test-'));
  return root;
}

/** Set file/dir mtime to N days ago */
function setAge(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
}

describe('cleanupStaleTempFiles', () => {
  let root: string;
  let fileTempBase: string;
  let tempBaseDir: string;

  beforeEach(() => {
    root = createTestRoot();
    fileTempBase = join(root, 'files');
    tempBaseDir = join(root, 'tmp');
    mkdirSync(fileTempBase, { recursive: true });
    mkdirSync(tempBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does nothing when tempMaxAgeDays is 0 (disabled)', () => {
    // Create an old file that would be deleted if cleanup ran
    const channelDir = join(fileTempBase, 'C001');
    mkdirSync(channelDir);
    const oldFile = join(channelDir, 'file1.txt');
    writeFileSync(oldFile, 'data');
    setAge(oldFile, 100);

    cleanupStaleTempFiles(0, tempBaseDir, fileTempBase);

    expect(existsSync(oldFile)).toBe(true);
  });

  it('does nothing when tempMaxAgeDays is negative (disabled)', () => {
    const channelDir = join(fileTempBase, 'C001');
    mkdirSync(channelDir);
    const oldFile = join(channelDir, 'file1.txt');
    writeFileSync(oldFile, 'data');
    setAge(oldFile, 100);

    cleanupStaleTempFiles(-5, tempBaseDir, fileTempBase);

    expect(existsSync(oldFile)).toBe(true);
  });

  describe('Slack download files', () => {
    it('deletes files older than cutoff', () => {
      const channelDir = join(fileTempBase, 'C001');
      mkdirSync(channelDir);
      const oldFile = join(channelDir, 'old.txt');
      writeFileSync(oldFile, 'old data');
      setAge(oldFile, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(oldFile)).toBe(false);
    });

    it('keeps files newer than cutoff', () => {
      const channelDir = join(fileTempBase, 'C001');
      mkdirSync(channelDir);
      const newFile = join(channelDir, 'new.txt');
      writeFileSync(newFile, 'new data');
      setAge(newFile, 10);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(newFile)).toBe(true);
    });

    it('removes empty channel dirs after cleanup', () => {
      const channelDir = join(fileTempBase, 'C001');
      mkdirSync(channelDir);
      const oldFile = join(channelDir, 'old.txt');
      writeFileSync(oldFile, 'data');
      setAge(oldFile, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(channelDir)).toBe(false);
    });
  });

  describe('orphaned req-* dirs', () => {
    it('deletes old req dirs when all files inside are old', () => {
      const reqDir = join(tempBaseDir, 'req-abc123');
      mkdirSync(reqDir);
      const file = join(reqDir, 'file.txt');
      writeFileSync(file, 'data');
      setAge(file, 100);
      setAge(reqDir, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(reqDir)).toBe(false);
    });

    it('keeps recent req dirs', () => {
      const reqDir = join(tempBaseDir, 'req-recent');
      mkdirSync(reqDir);
      writeFileSync(join(reqDir, 'file.txt'), 'data');
      setAge(reqDir, 10);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(reqDir)).toBe(true);
    });

    it('keeps req dir when dir mtime is old but file inside is recent', () => {
      const reqDir = join(tempBaseDir, 'req-active');
      mkdirSync(reqDir);
      const file = join(reqDir, 'attachment.txt');
      writeFileSync(file, 'recent data');
      setAge(file, 10);
      setAge(reqDir, 200);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(reqDir)).toBe(true);
    });

    it('keeps fresh empty req dir (falls back to dir mtime)', () => {
      const reqDir = join(tempBaseDir, 'req-fresh');
      mkdirSync(reqDir);
      // Dir was just created — mtime is now, no files inside

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(reqDir)).toBe(true);
    });

    it('deletes old empty req dir', () => {
      const reqDir = join(tempBaseDir, 'req-abandoned');
      mkdirSync(reqDir);
      setAge(reqDir, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(reqDir)).toBe(false);
    });
  });

  describe('pointer files', () => {
    it('deletes old .current pointer files', () => {
      const pointer = join(tempBaseDir, 'C001.current');
      writeFileSync(pointer, '/some/path');
      setAge(pointer, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(pointer)).toBe(false);
    });

    it('keeps recent .current pointer files', () => {
      const pointer = join(tempBaseDir, 'C001.current');
      writeFileSync(pointer, '/some/path');
      setAge(pointer, 10);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(pointer)).toBe(true);
    });
  });

  describe('scratch dirs', () => {
    it('deletes scratch dir when all files inside are old', () => {
      const scratchDir = join(tempBaseDir, 'scratch', 'C001');
      mkdirSync(scratchDir, { recursive: true });
      const oldFile = join(scratchDir, 'report.md');
      writeFileSync(oldFile, 'old report');
      setAge(oldFile, 100);
      setAge(scratchDir, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(scratchDir)).toBe(false);
    });

    it('keeps scratch dir when a file inside was recently modified', () => {
      const scratchDir = join(tempBaseDir, 'scratch', 'C001');
      mkdirSync(scratchDir, { recursive: true });
      const recentFile = join(scratchDir, 'report.md');
      writeFileSync(recentFile, 'active report');
      setAge(recentFile, 10);
      // Directory mtime is old — this is the scenario that would break
      // if we only checked dir mtime
      setAge(scratchDir, 200);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(scratchDir)).toBe(true);
    });

    it('deletes old empty scratch dirs', () => {
      const scratchDir = join(tempBaseDir, 'scratch', 'C001');
      mkdirSync(scratchDir, { recursive: true });
      setAge(scratchDir, 100);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(scratchDir)).toBe(false);
    });

    it('keeps fresh empty scratch dirs', () => {
      const scratchDir = join(tempBaseDir, 'scratch', 'C001');
      mkdirSync(scratchDir, { recursive: true });

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(scratchDir)).toBe(true);
    });

    it('uses newest nested file mtime for deep subtrees', () => {
      const scratchDir = join(tempBaseDir, 'scratch', 'C001');
      const subDir = join(scratchDir, 'sub', 'deep');
      mkdirSync(subDir, { recursive: true });
      const deepFile = join(subDir, 'recent.txt');
      writeFileSync(deepFile, 'recent');
      setAge(deepFile, 5);
      // All parent dirs have old mtime
      setAge(scratchDir, 200);
      setAge(join(scratchDir, 'sub'), 200);
      setAge(subDir, 200);

      cleanupStaleTempFiles(90, tempBaseDir, fileTempBase);

      expect(existsSync(scratchDir)).toBe(true);
    });
  });

  it('handles non-existent directories gracefully', () => {
    const missingFiles = join(root, 'nonexistent-files');
    const missingTemp = join(root, 'nonexistent-tmp');

    // Should not throw
    expect(() => cleanupStaleTempFiles(90, missingTemp, missingFiles)).not.toThrow();
  });
});
