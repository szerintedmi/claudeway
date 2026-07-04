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
      await handleCredsRequest(new Request(`http://x/creds?t=bogus-${i}`), '9.9.9.9');
    }
    const res = await handleCredsRequest(new Request('http://x/creds?t=bogus-final'), '9.9.9.9');
    expect(res!.status).toBe(429);
  });

  it('rate-limits per IP — one abuser cannot lock out other enrollees', async () => {
    // Attacker burns through their own budget from a single IP...
    for (let i = 0; i < 6; i++) {
      await handleCredsRequest(new Request(`http://x/creds?t=bad-${i}`), '1.2.3.4');
    }
    expect((await handleCredsRequest(new Request('http://x/creds?t=x'), '1.2.3.4'))!.status).toBe(
      429,
    );
    // ...but a different client is unaffected (gets the normal expired-link page,
    // not a 429 — the old process-wide limiter would have 429'd everyone).
    const other = await handleCredsRequest(new Request('http://x/creds?t=x'), '5.6.7.8');
    expect(other!.status).not.toBe(429);
    expect(await other!.text()).toContain('Link expired');
  });

  it('rejects unsupported methods', async () => {
    const res = await handleCredsRequest(new Request('http://x/creds', { method: 'DELETE' }));
    expect(res!.status).toBe(405);
  });
});
