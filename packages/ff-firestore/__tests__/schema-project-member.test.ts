/**
 * Project / member zod schemas match what the Cloud Functions write
 * (wave 63 review item 10). Pure zod — no emulator.
 */
import { describe, expect, it } from 'vitest';

import { ProjectSchema } from '../src/schema/project';
import { MemberSchema } from '../src/schema/member';
import { toEpochMillis } from '../src/schema/timestamp';

/** Shape of a Firestore Timestamp as read back by either SDK. */
const ts = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: (ms % 1000) * 1e6,
  toMillis: () => ms,
});

describe('ProjectSchema', () => {
  it('accepts the bootstrap write: name + server Timestamp + createdBy', () => {
    const doc = { name: 'Default Project', createdAt: ts(1_700_000_000_000), createdBy: 'uid1' };
    expect(ProjectSchema.parse(doc)).toMatchObject({ name: 'Default Project', createdBy: 'uid1' });
  });
  it('accepts epoch millis for createdAt', () => {
    expect(ProjectSchema.safeParse({ name: 'P', createdAt: 1, createdBy: 'u' }).success).toBe(true);
  });
  it('requires createdBy and rejects a non-time createdAt', () => {
    expect(ProjectSchema.safeParse({ name: 'P', createdAt: ts(1) }).success).toBe(false);
    expect(ProjectSchema.safeParse({ name: 'P', createdAt: '2026-01-01', createdBy: 'u' }).success).toBe(false);
  });
});

describe('MemberSchema', () => {
  it('accepts the bootstrap member (Timestamp joinedAt, invitedBy "bootstrap")', () => {
    const doc = { role: 'admin', joinedAt: ts(5), invitedBy: 'bootstrap', status: 'active' };
    expect(MemberSchema.safeParse(doc).success).toBe(true);
  });
  it('accepts the invitation member (epoch millis joinedAt)', () => {
    const doc = { role: 'member', joinedAt: 1_700_000_000_000, invitedBy: 'uidA', status: 'active' };
    expect(MemberSchema.safeParse(doc).success).toBe(true);
  });
  it('toEpochMillis handles both forms', () => {
    expect(toEpochMillis(42)).toBe(42);
    expect(toEpochMillis(ts(1234))).toBe(1234);
  });
});
