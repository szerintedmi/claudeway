import { credentialFields, loadConfig, type Config, type CredentialDef } from '../../config.js';
import { getSecretStore } from '../../secrets.js';
import { peekLink, redeemLink } from '../../creds-links.js';
import { audit } from '../../audit.js';

/**
 * Credential enrollment form — a small HTTP server serving GET/POST /creds.
 * Reached via single-use magic links issued by the `!creds` Slack DM command.
 * Intended for LAN/VPN exposure; put HTTPS in front before exposing wider
 * (merged-plan Future #6).
 */

export const DEFAULT_CREDS_PORT = 8791;

/**
 * Progressive-backoff rate limiter for invalid form/link attempts, keyed by
 * client IP. A process-wide global (the old design) let 3 anonymous requests
 * with any invalid/expired token lock EVERY enrollee out for 5 minutes — a
 * trivial unauthenticated DoS. Per-IP keying confines the backoff to the
 * offending client.
 */
const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const RATE_LIMITER_MAX_ENTRIES = 10_000;

interface RateEntry {
  failureCount: number;
  lastFailureTime: number;
}
const rateLimiter = new Map<string, RateEntry>();

function pruneRateLimiter(now: number): void {
  if (rateLimiter.size <= RATE_LIMITER_MAX_ENTRIES) return;
  // Drop entries whose backoff window has fully elapsed — they're back to a
  // clean slate anyway, so forgetting them changes nothing.
  for (const [ip, e] of rateLimiter) {
    if (now - e.lastFailureTime >= MAX_DELAY_MS) rateLimiter.delete(ip);
  }
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const e = rateLimiter.get(ip) ?? { failureCount: 0, lastFailureTime: 0 };
  e.failureCount++;
  e.lastFailureTime = now;
  rateLimiter.set(ip, e);
  pruneRateLimiter(now);
}

function isRateLimited(ip: string): boolean {
  const e = rateLimiter.get(ip);
  if (!e || e.failureCount < FREE_ATTEMPTS) return false;
  const backoffExponent = e.failureCount - FREE_ATTEMPTS;
  const cooldownMs = Math.min(BASE_DELAY_MS * (1 << backoffExponent), MAX_DELAY_MS);
  return Date.now() - e.lastFailureTime < cooldownMs;
}

function clearFailures(ip: string): void {
  rateLimiter.delete(ip);
}

/** Test hook. */
export function resetCredsRateLimiterForTests(): void {
  rateLimiter.clear();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;background:#1a1a2e;color:#eee}
h1{font-size:1.3rem}h2{font-size:1rem;margin:1.5rem 0 .25rem}
input{width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0;border-radius:6px;border:1px solid #444;background:#0f0f1e;color:#eee;font-family:monospace}
input[type=checkbox]{width:auto;margin:0 .4rem 0 0;accent-color:#c44}
.del{display:block;color:#e88;font-size:.85rem;margin:.35rem 0 0}
button{margin-top:1rem;padding:.6rem 1.4rem;border-radius:6px;border:0;background:#0a9396;color:#fff;font-size:1rem;cursor:pointer}
.hint{color:#9aa;font-size:.85rem;margin:.15rem 0}
.set{color:#7c7;font-size:.85rem}
.warn{color:#fb0}
</style></head><body>${body}</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Which credential types this user may enroll. */
function enrollableCreds(config: Config): Array<[string, CredentialDef]> {
  return Object.entries(config.userCredentials ?? {});
}

function renderForm(config: Config, userId: string, token: string): Response {
  const store = getSecretStore();
  const setNames = new Set(store.listNames(userId));
  const creds = enrollableCreds(config);
  if (creds.length === 0) {
    return page(
      'Claudeway credentials',
      `<h1>Claudeway credentials</h1><p class="warn">No credential types are available for your permissions.</p>`,
    );
  }

  const sections = creds
    .map(([name, def]) => {
      const fields = credentialFields(def)
        .map(
          ({ name: fieldName, def: fieldDef }) =>
            `<label class="hint" for="${escapeHtml(`${name}.${fieldName}`)}">${escapeHtml(fieldDef.label ?? fieldName)}</label>
<input id="${escapeHtml(`${name}.${fieldName}`)}" name="${escapeHtml(`${name}.${fieldName}`)}" type="${fieldDef.secret === false ? 'text' : 'password'}" autocomplete="off" placeholder="${setNames.has(name) ? 'leave blank to keep current value' : ''}">`,
        )
        .join('\n');
      const status = setNames.has(name) ? '<span class="set">✓ set</span>' : '';
      const guidance = def.guidance ? `<p class="hint">${escapeHtml(def.guidance)}</p>` : '';
      // Deletion only offered for stored credentials; it wins over typed values
      const del = setNames.has(name)
        ? `<label class="del"><input type="checkbox" name="${escapeHtml(`${name}.__delete`)}">Delete my stored ${escapeHtml(def.label)} credential (ignores values typed above)</label>`
        : '';
      return `<h2>${escapeHtml(def.label)} ${status}</h2>${guidance}${fields}${del}`;
    })
    .join('\n');

  return page(
    'Claudeway credentials',
    `<h1>Connect your credentials</h1>
<p class="hint">Use least-privilege tokens: project-scoped Jira tokens, fine-grained GitHub PATs limited
to the repos you need, read-only where possible. Values are encrypted at rest; this link is single-use.</p>
<form method="post" action="/creds">
<input type="hidden" name="t" value="${escapeHtml(token)}">
${sections}
<button type="submit">Save changes</button>
</form>`,
  );
}

async function handlePost(req: Request, clientIp: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const token = form?.get('t');
  if (!form || typeof token !== 'string' || !token) {
    recordFailure(clientIp);
    return page('Invalid request', '<h1>Invalid request</h1><p class="warn">Missing token.</p>');
  }

  // Single-use: the token is consumed regardless of what follows
  const userId = redeemLink(token);
  if (!userId) {
    recordFailure(clientIp);
    return page(
      'Link expired',
      '<h1>Link expired</h1><p class="warn">This link is invalid, expired, or already used. DM the bot <code>!creds</code> for a fresh one.</p>',
    );
  }
  clearFailures(clientIp);

  const config = loadConfig();
  const store = getSecretStore();

  const saved: string[] = [];
  const deleted: string[] = [];
  for (const [name, def] of enrollableCreds(config)) {
    // Delete wins over typed values — checking the box means "remove it"
    if (form.get(`${name}.__delete`)) {
      if (store.delete(userId, name)) deleted.push(name);
      continue;
    }
    const value: Record<string, string> = store.get(userId, name) ?? {};
    let changed = false;
    for (const { name: fieldName } of credentialFields(def)) {
      const submitted = form.get(`${name}.${fieldName}`);
      if (typeof submitted === 'string' && submitted.trim().length > 0) {
        value[fieldName] = submitted.trim();
        changed = true;
      }
    }
    if (changed) {
      store.set(userId, name, value);
      saved.push(name);
    }
  }

  if (saved.length > 0) {
    audit({ event: 'creds.set', userId, credNames: saved });
  }
  if (deleted.length > 0) {
    audit({ event: 'creds.deleted', userId, credNames: deleted, detail: 'deleted via web form' });
  }

  const codes = (names: string[]) => names.map((n) => `<code>${escapeHtml(n)}</code>`).join(', ');
  const parts = [
    ...(saved.length > 0 ? [`Stored: ${codes(saved)}.`] : []),
    ...(deleted.length > 0 ? [`Deleted: ${codes(deleted)}.`] : []),
  ];
  return page(
    'Saved',
    parts.length > 0
      ? `<h1>Credentials updated</h1><p>${parts.join(' ')} You can close this tab. Manage them anytime with <code>!creds list</code> / <code>!creds revoke</code>.</p>`
      : '<h1>Nothing saved</h1><p class="warn">All fields were empty. DM the bot <code>!creds</code> for a fresh link and try again.</p>',
  );
}

/**
 * Handle a request for the /creds routes. Returns null when the path doesn't
 * match. `clientIp` keys the rate limiter (defaults to a shared bucket when the
 * caller can't resolve one, e.g. tests).
 */
export async function handleCredsRequest(
  req: Request,
  clientIp = 'unknown',
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== '/creds') return null;

  if (isRateLimited(clientIp)) {
    return new Response('Too many attempts — try again later', { status: 429 });
  }

  if (req.method === 'GET') {
    const token = url.searchParams.get('t') ?? '';
    const userId = token ? peekLink(token) : null;
    if (!userId) {
      recordFailure(clientIp);
      return page(
        'Link expired',
        '<h1>Link expired</h1><p class="warn">This link is invalid, expired, or already used. DM the bot <code>!creds</code> for a fresh one.</p>',
      );
    }
    return renderForm(loadConfig(), userId, token);
  }

  if (req.method === 'POST') {
    return handlePost(req, clientIp);
  }

  return new Response('Method Not Allowed', { status: 405 });
}

/** Start the credential form HTTP server (always on — enrollment is mandatory). */
export function startCredsServer(config: Config): void {
  const port = config.credsForm?.port ?? DEFAULT_CREDS_PORT;
  const hostname = config.credsForm?.host ?? '0.0.0.0';

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const clientIp = server.requestIP(req)?.address ?? 'unknown';
      const res = await handleCredsRequest(req, clientIp);
      return res ?? new Response('Not Found', { status: 404 });
    },
  });

  console.log(`[creds] Credential form listening on ${hostname}:${port}`);
}
