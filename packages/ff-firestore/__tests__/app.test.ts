/**
 * initFirestore enables the multi-tab persistent cache and logs (not
 * swallows) the fallback (wave 63 review item 9).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const initializeFirestore = vi.fn();
const getFirestore = vi.fn(() => ({ fallback: true }));
const persistentLocalCache = vi.fn((s: unknown) => ({ cache: s }));
const persistentMultipleTabManager = vi.fn(() => ({ multiTab: true }));
vi.mock('firebase/firestore', () => ({
  initializeFirestore: (...a: unknown[]) => initializeFirestore(...a),
  getFirestore: () => getFirestore(),
  persistentLocalCache: (s: unknown) => persistentLocalCache(s),
  persistentMultipleTabManager: () => persistentMultipleTabManager(),
}));

import { initFirestore, __resetFirestoreForTests } from '../src/app';

afterEach(() => {
  __resetFirestoreForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('initFirestore', () => {
  it('uses persistentLocalCache with the multiple-tab manager', () => {
    initializeFirestore.mockReturnValueOnce({ ok: true });
    const app = {} as never;
    expect(initFirestore(app)).toEqual({ ok: true });
    expect(initializeFirestore).toHaveBeenCalledWith(app, {
      localCache: { cache: { tabManager: { multiTab: true } } },
    });
  });
  it('logs the fallback instead of swallowing it', () => {
    initializeFirestore.mockImplementationOnce(() => {
      throw new Error('already started');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(initFirestore({} as never)).toEqual({ fallback: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('multi-tab cache not enabled'), expect.any(Error));
  });
});
