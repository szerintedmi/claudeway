import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';

/**
 * Single-use, short-TTL magic links for the credential enrollment form.
 * In-memory only (links do not survive restarts — Future #6 is HMAC-signed
 * stateless links). The link token is random 128-bit; the secret itself
 * never transits Slack.
 */

export const LINK_TTL_MS = 10 * 60 * 1000;

interface PendingLink {
  userId: string;
  expiresAt: number;
}

const pendingLinks = new Map<string, PendingLink>();

function prune(now: number): void {
  for (const [token, link] of pendingLinks) {
    if (link.expiresAt <= now) pendingLinks.delete(token);
  }
}

/** Issue a fresh single-use token for a canonical user id. */
export function issueLink(userId: string, now: number = Date.now()): string {
  prune(now);
  const token = randomUUID();
  pendingLinks.set(token, { userId, expiresAt: now + LINK_TTL_MS });
  audit({ event: 'link.issued', userId });
  return token;
}

/**
 * Validate a token without consuming it (GET /creds form render).
 * Returns the canonical user id, or null when unknown/expired.
 */
export function peekLink(token: string, now: number = Date.now()): string | null {
  prune(now);
  return pendingLinks.get(token)?.userId ?? null;
}

/**
 * Consume a token (POST /creds). Single-use: the token is deleted whether
 * or not it was valid. Returns the canonical user id, or null.
 */
export function redeemLink(token: string, now: number = Date.now()): string | null {
  prune(now);
  const link = pendingLinks.get(token);
  pendingLinks.delete(token);
  if (!link) {
    audit({
      event: 'link.rejected',
      userId: 'unknown',
      detail: 'invalid, expired, or reused token',
    });
    return null;
  }
  audit({ event: 'link.redeemed', userId: link.userId });
  return link.userId;
}

/** Test hook — clear all pending links. */
export function resetLinksForTests(): void {
  pendingLinks.clear();
}
