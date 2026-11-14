// @vitest-environment node
// packages/ff-auth — demo mode unit tests.
//
// These run in vitest's default `node` environment (the package has no
// jsdom dependency), so the browser globals the demo module touches
// (localStorage, window/EventTarget) are stubbed explicitly. That also
// proves the module never assumes a browser: it degrades to the safe
// 'viewer' default when storage is unavailable.
//
// The demo module is the single source of truth for the mocked sign-in
// (plan v4 amendment v4.1), so these tests cover:
//   - default viewer
//   - set / persist
//   - the change event

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEMO_ROLE_CHANGED_EVENT,
  DEMO_ROLE_STORAGE_KEY,
  getDemoRole,
  isDemoAuth,
  setDemoRole,
  subscribeDemoRole,
} from '../src/demo';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('isDemoAuth', () => {
  it('is off unless VITE_FF_DEMO_AUTH is exactly "true"', () => {
    expect(isDemoAuth()).toBe(false);

    vi.stubEnv('VITE_FF_DEMO_AUTH', 'false');
    expect(isDemoAuth()).toBe(false);

    vi.stubEnv('VITE_FF_DEMO_AUTH', '1');
    expect(isDemoAuth()).toBe(false);

    vi.stubEnv('VITE_FF_DEMO_AUTH', 'true');
    expect(isDemoAuth()).toBe(true);
  });
});

describe('getDemoRole', () => {
  it('defaults to viewer (an unregistered visitor is never admin)', () => {
    expect(getDemoRole()).toBe('viewer');
  });

  it('falls back to viewer for an unknown stored value', () => {
    localStorage.setItem(DEMO_ROLE_STORAGE_KEY, 'superadmin');
    expect(getDemoRole()).toBe('viewer');
  });

  it('reads the persisted role', () => {
    localStorage.setItem(DEMO_ROLE_STORAGE_KEY, 'admin');
    expect(getDemoRole()).toBe('admin');
  });
});

describe('setDemoRole', () => {
  it('persists the role so it survives a reload', () => {
    setDemoRole('admin');

    expect(localStorage.getItem(DEMO_ROLE_STORAGE_KEY)).toBe('admin');
    expect(getDemoRole()).toBe('admin');

    setDemoRole('viewer');
    expect(localStorage.getItem(DEMO_ROLE_STORAGE_KEY)).toBe('viewer');
    expect(getDemoRole()).toBe('viewer');
  });

  it('fires the role-changed event with the new role', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDemoRole((role) => seen.push(role));

    setDemoRole('admin');

    expect(seen).toEqual(['admin']);

    unsubscribe();
  });

  it('notifies every subscriber', () => {
    const first: string[] = [];
    const second: string[] = [];
    const unsubFirst = subscribeDemoRole((role) => first.push(role));
    const unsubSecond = subscribeDemoRole((role) => second.push(role));

    setDemoRole('admin');

    expect(first).toEqual(['admin']);
    expect(second).toEqual(['admin']);

    unsubFirst();
    unsubSecond();
  });
});

describe('subscribeDemoRole', () => {
  it('stops notifying after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDemoRole((role) => seen.push(role));

    setDemoRole('admin');
    unsubscribe();
    setDemoRole('viewer');

    expect(seen).toEqual(['admin']);
  });

  it('is a no-op outside a browser (no window global)', () => {
    vi.stubGlobal('window', undefined);
    const unsubscribe = subscribeDemoRole(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('uses the documented event name', () => {
    expect(DEMO_ROLE_CHANGED_EVENT).toBe('ff-demo-role-changed');
  });
});
