// apps/users — useMembers: loading state + staleness token (wave 63).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type Snap = { docs: Array<{ id: string; data: () => { role: string; status: string } }> };

const h = vi.hoisted(() => ({
  app: {},
  project: undefined as undefined | null | { id: string; role: string },
  listeners: [] as Array<{ next: (s: unknown) => void; unsubscribed: boolean }>,
  emailResolvers: new Map<string, Array<(email: string) => void>>(),
}));

vi.mock('@ff/auth', () => ({
  useAuthContext: () => ({ app: h.app }),
  useCurrentProject: () => h.project,
}));

vi.mock('@ff/firestore', () => ({
  membersCollection: (_db: unknown, projectId: string) => ({ projectId }),
  userDoc: (_db: unknown, uid: string) => ({ uid }),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  onSnapshot: (_ref: unknown, next: (s: unknown) => void) => {
    const entry = { next, unsubscribed: false };
    h.listeners.push(entry);
    return () => {
      entry.unsubscribed = true;
    };
  },
  getDoc: (ref: { uid: string }) =>
    new Promise((resolve) => {
      const list = h.emailResolvers.get(ref.uid) ?? [];
      list.push((email: string) => resolve({ exists: () => true, data: () => ({ email }) }));
      h.emailResolvers.set(ref.uid, list);
    }),
}));

import { useMembers } from '../src/hooks/useMembers';

function snap(...uids: string[]): Snap {
  return { docs: uids.map((id) => ({ id, data: () => ({ role: 'member', status: 'active' }) })) };
}

async function resolveEmail(uid: string, index: number, email: string) {
  await act(async () => {
    h.emailResolvers.get(uid)![index](email);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.project = undefined;
  h.listeners = [];
  h.emailResolvers = new Map();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMembers', () => {
  it('stays undefined (loading) while the project is still resolving', () => {
    const { result } = renderHook(() => useMembers());
    expect(result.current).toBeUndefined();
    expect(h.listeners).toHaveLength(0);
  });

  it('returns [] only once the project resolved to none', () => {
    h.project = null;
    const { result } = renderHook(() => useMembers());
    expect(result.current).toEqual([]);
  });

  it('ignores a slower email join from an older snapshot', async () => {
    h.project = { id: 'p1', role: 'admin' };
    const { result } = renderHook(() => useMembers());
    expect(result.current).toBeUndefined();

    act(() => {
      void h.listeners[0].next(snap('a'));
    });
    act(() => {
      void h.listeners[0].next(snap('a', 'b'));
    });

    // Newer snapshot finishes first.
    await resolveEmail('a', 1, 'a@x.test');
    await resolveEmail('b', 0, 'b@x.test');
    expect(result.current?.map((r) => r.uid)).toEqual(['a', 'b']);

    // The stale join completes late and must not overwrite it.
    await resolveEmail('a', 0, 'a@x.test');
    expect(result.current?.map((r) => r.uid)).toEqual(['a', 'b']);
  });

  it('resets to loading and drops the old listener when the project changes', async () => {
    h.project = { id: 'p1', role: 'admin' };
    const { result, rerender } = renderHook(() => useMembers());
    act(() => {
      void h.listeners[0].next(snap('a'));
    });
    await resolveEmail('a', 0, 'a@x.test');
    expect(result.current).toHaveLength(1);

    h.project = { id: 'p2', role: 'admin' };
    rerender();
    expect(result.current).toBeUndefined();
    expect(h.listeners[0].unsubscribed).toBe(true);
  });
});
