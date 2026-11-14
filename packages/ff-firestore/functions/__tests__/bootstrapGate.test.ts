// @vitest-environment node
/**
 * Unit tests for the bootstrapFirstAdmin gate helpers (wave 63).
 */
import { describe, it, expect } from 'vitest';
import {
  decideCallerMode,
  parseEmailAllowlist,
  secretsMatch,
} from '../src/bootstrapGate';

describe('secretsMatch (constant-time compare)', () => {
  it('matches only the exact secret', () => {
    expect(secretsMatch('s3cret', 's3cret')).toBe(true);
    expect(secretsMatch('s3cret', 's3creT')).toBe(false);
    expect(secretsMatch('s3cret-longer', 's3cret')).toBe(false);
    expect(secretsMatch('s3c', 's3cret')).toBe(false);
  });

  it('never matches when either side is empty or not a string', () => {
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch('x', '')).toBe(false);
    expect(secretsMatch('x', undefined)).toBe(false);
    expect(secretsMatch(undefined, 'x')).toBe(false);
    expect(secretsMatch(123, '123')).toBe(false);
  });
});

describe('parseEmailAllowlist', () => {
  it('splits on commas/whitespace, lowercases, drops junk', () => {
    const s = parseEmailAllowlist(' A@x.com, b@Y.com ;c@z.com  nope ');
    expect([...s].sort()).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    expect(parseEmailAllowlist('').size).toBe(0);
    expect(parseEmailAllowlist(undefined).size).toBe(0);
  });
});

describe('decideCallerMode (caller mode B gate)', () => {
  const base = {
    email: 'Owner@Example.com',
    emailVerified: true,
    providedSecret: undefined,
    expectedSecret: 'the-secret',
    allowlistRaw: '',
  };

  it('DENIES a verified caller with neither secret nor allowlist entry (first-caller takeover)', () => {
    expect(decideCallerMode(base)).toMatchObject({ ok: false, reason: 'not-authorized' });
  });

  it('DENIES an unverified email even with the right secret or an allowlist entry', () => {
    expect(
      decideCallerMode({ ...base, emailVerified: false, providedSecret: 'the-secret' })
    ).toMatchObject({ ok: false, reason: 'email-not-verified' });
    expect(
      decideCallerMode({ ...base, emailVerified: undefined, allowlistRaw: 'owner@example.com' })
    ).toMatchObject({ ok: false, reason: 'email-not-verified' });
  });

  it('DENIES a caller without an email', () => {
    expect(decideCallerMode({ ...base, email: undefined })).toMatchObject({ ok: false });
  });

  it('allows the right secret', () => {
    expect(decideCallerMode({ ...base, providedSecret: 'the-secret' })).toEqual({
      ok: true,
      via: 'secret',
      emailLower: 'owner@example.com',
    });
  });

  it('DENIES a wrong secret, and any secret when none is configured', () => {
    expect(decideCallerMode({ ...base, providedSecret: 'guess' })).toMatchObject({ ok: false });
    expect(
      decideCallerMode({ ...base, providedSecret: '', expectedSecret: '' })
    ).toMatchObject({ ok: false });
  });

  it('allows an allowlisted verified email (case-insensitive)', () => {
    expect(
      decideCallerMode({ ...base, allowlistRaw: 'someone@else.com, OWNER@example.com' })
    ).toEqual({ ok: true, via: 'allowlist', emailLower: 'owner@example.com' });
  });
});
