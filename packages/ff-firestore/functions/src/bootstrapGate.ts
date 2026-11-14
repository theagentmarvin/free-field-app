/**
 * Pure gate helpers for `bootstrapFirstAdmin` (wave 63).
 *
 * Kept free of firebase-functions / firebase-admin imports so they can be
 * unit-tested without the emulator.
 */

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time secret compare. Both sides are hashed to a fixed 32-byte
 * digest first, so the compare time does not depend on the length or on
 * where the first differing byte is. An empty expected secret never matches.
 */
export function secretsMatch(
  provided: unknown,
  expected: string | undefined | null
): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Parse a comma/whitespace-separated email allowlist (lowercased). */
export function parseEmailAllowlist(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e.includes('@')) out.add(e);
  }
  return out;
}

export interface CallerModeInput {
  email: string | undefined | null;
  emailVerified: boolean | undefined | null;
  providedSecret: unknown;
  expectedSecret: string | undefined | null;
  allowlistRaw: string | undefined | null;
}

export type CallerModeDecision =
  | { ok: true; via: 'secret' | 'allowlist'; emailLower: string }
  | { ok: false; code: 'permission-denied'; reason: string };

/**
 * Caller mode (B) of the first-admin bootstrap. The caller must:
 *   1. have an email on the token that is VERIFIED, and
 *   2. either present the deployer's BOOTSTRAP_SECRET, or have that
 *      verified email on the BOOTSTRAP_ADMIN_EMAILS allowlist.
 * Without (2), the first person to sign in to a fresh deployment would
 * become its admin.
 */
export function decideCallerMode(input: CallerModeInput): CallerModeDecision {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return { ok: false, code: 'permission-denied', reason: 'no-email' };
  }
  if (input.emailVerified !== true) {
    return { ok: false, code: 'permission-denied', reason: 'email-not-verified' };
  }
  if (secretsMatch(input.providedSecret, input.expectedSecret)) {
    return { ok: true, via: 'secret', emailLower: email };
  }
  if (parseEmailAllowlist(input.allowlistRaw).has(email)) {
    return { ok: true, via: 'allowlist', emailLower: email };
  }
  return { ok: false, code: 'permission-denied', reason: 'not-authorized' };
}
