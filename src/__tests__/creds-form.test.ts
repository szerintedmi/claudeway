import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleCredsRequest, resetCredsRateLimiterForTests } from '../adapters/creds/index.js';
import { resetLinksForTests } from '../creds-links.js';
import { setAuditBaseDir } from '../audit.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudeway-credsform-test-'));
  setAuditBaseDir(dir);
  resetLinksForTests();
  resetCredsRateLimiterForTests();
});
afterEach(() => {
  setAuditBaseDir(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('handleCredsRequest', () => {
  it('ignores non-/creds paths', async () => {
    expect(await handleCredsRequest(new Request('http://x/other'))).toBeNull();
  });

  it('rejects a GET with a missing or invalid token', async () => {
    const res = await handleCredsRequest(new Request('http://x/creds?t=bogus'));
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain('Link expired');
  });

  it('rejects a forged POST without a valid token', async () => {
    const body = new URLSearchParams({ t: 'forged', 'jira.JIRA_API_TOKEN': 'evil' });
    const res = await handleCredsRequest(
      new Request('http://x/creds', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(await res!.text()).toContain('Link expired');
  });

  it('rate-limits after repeated invalid attempts', async () => {
    for (let i = 0; i < 4; i++) {
      await handleCredsRequest(new Request(`http://x/creds?t=bogus-${i}`));
    }
    const res = await handleCredsRequest(new Request('http://x/creds?t=bogus-final'));
    expect(res!.status).toBe(429);
  });

  it('rejects unsupported methods', async () => {
    const res = await handleCredsRequest(new Request('http://x/creds', { method: 'DELETE' }));
    expect(res!.status).toBe(405);
  });
});
