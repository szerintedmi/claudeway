import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  issueLink,
  peekLink,
  redeemLink,
  resetLinksForTests,
  LINK_TTL_MS,
} from '../creds-links.js';
import { setAuditBaseDir, auditFilePath } from '../audit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudeway-links-test-'));
  setAuditBaseDir(dir);
  resetLinksForTests();
});
afterEach(() => {
  setAuditBaseDir(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function auditLines(): Array<Record<string, unknown>> {
  const path = auditFilePath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe('magic links', () => {
  it('issue → peek → redeem resolves the canonical user id', () => {
    const token = issueLink('petro');
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(peekLink(token)).toBe('petro');
    expect(redeemLink(token)).toBe('petro');
  });

  it('is single-use: a redeemed token cannot be reused', () => {
    const token = issueLink('petro');
    expect(redeemLink(token)).toBe('petro');
    expect(redeemLink(token)).toBeNull();
    expect(peekLink(token)).toBeNull();
  });

  it('expires after the TTL', () => {
    const now = Date.now();
    const token = issueLink('petro', now);
    expect(peekLink(token, now + LINK_TTL_MS - 1)).toBe('petro');
    expect(peekLink(token, now + LINK_TTL_MS)).toBeNull();
    expect(redeemLink(token, now + LINK_TTL_MS)).toBeNull();
  });

  it('rejects unknown tokens', () => {
    expect(redeemLink('not-a-token')).toBeNull();
  });

  it('audits issue, redeem, and rejection — without values', () => {
    const token = issueLink('petro');
    redeemLink(token);
    redeemLink('bogus');
    const events = auditLines().map((e) => e.event);
    expect(events).toEqual(['link.issued', 'link.redeemed', 'link.rejected']);
    // The audit log never contains the link token itself
    expect(readFileSync(auditFilePath(dir), 'utf-8')).not.toContain(token);
  });
});
