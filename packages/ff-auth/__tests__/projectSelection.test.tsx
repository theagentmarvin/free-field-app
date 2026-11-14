// packages/ff-auth — the ONE current-project source (wave 65).
//
// Covers:
//   - pure resolution (loading / signed out / hint / auto-pick / leave);
//   - switching between N memberships, with membership validation;
//   - sign-out clears the selection AND the localStorage hint, and a new
//     uid never inherits the previous user's choice;
//   - the demo provider resolves DEMO_PROJECT_ID and refuses others;
//   - no project → no writes (useRequiredProjectId / requireProjectId).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { Component, type ReactNode } from 'react';

import {
  AuthProvider,
  DEMO_PROJECT_ID,
  NoActiveProjectError,
  PROJECT_CHOICE_KEY,
  requireProjectId,
  resolveCurrentProjectId,
  useProjectId,
  useProjectSelection,
  useRequiredProjectId,
  type ProjectMembership,
} from '../src';
import { useProjectSelectionState } from '../src/projectSelection';

const A: ProjectMembership = { id: 'p-a', role: 'admin', name: 'Torre A' };
const B: ProjectMembership = { id: 'p-b', role: 'member', name: 'Torre B' };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveCurrentProjectId', () => {
  const sel = (id: string | null, explicit = false, uid: string | null = 'u1') => ({ uid, id, explicit });

  it('is null when signed out and undefined while memberships load', () => {
    expect(resolveCurrentProjectId(sel(null, false, null), [A])).toBeNull();
    expect(resolveCurrentProjectId(sel('p-a'), undefined)).toBeUndefined();
  });

  it('accepts a selection only when it is a membership', () => {
    expect(resolveCurrentProjectId(sel('p-b'), [A, B])).toBe('p-b');
    expect(resolveCurrentProjectId(sel('p-x'), [A, B])).toBeNull();
  });

  it('auto-picks a single membership unless the user explicitly left', () => {
    expect(resolveCurrentProjectId(sel(null), [A])).toBe('p-a');
    expect(resolveCurrentProjectId(sel('stale'), [A])).toBe('p-a');
    expect(resolveCurrentProjectId(sel(null, true), [A])).toBeNull();
    expect(resolveCurrentProjectId(sel(null), [A, B])).toBeNull();
    expect(resolveCurrentProjectId(sel(null), [])).toBeNull();
  });
});

describe('useProjectSelectionState (provider state machine)', () => {
  function setup(initial: { uid: string | null; memberships: ProjectMembership[] | undefined }) {
    return renderHook(
      ({ uid, memberships }) => useProjectSelectionState(uid, memberships),
      { initialProps: initial },
    );
  }

  it('starts from a valid hint and switches between memberships', () => {
    localStorage.setItem(PROJECT_CHOICE_KEY, 'p-b');
    const { result } = setup({ uid: 'u1', memberships: [A, B] });
    expect(result.current.currentProjectId).toBe('p-b');

    let ok = false;
    act(() => {
      ok = result.current.switchProject('p-a');
    });
    expect(ok).toBe(true);
    expect(result.current.currentProjectId).toBe('p-a');
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe('p-a');
  });

  it('refuses a project the user is not a member of', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = setup({ uid: 'u1', memberships: [A, B] });
    act(() => {
      result.current.switchProject('p-a');
    });
    let ok = true;
    act(() => {
      ok = result.current.setCurrentProject('p-intruder');
    });
    expect(ok).toBe(false);
    expect(result.current.currentProjectId).toBe('p-a');
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe('p-a');
  });

  it('ignores a hint that is not a membership (several projects → picker)', () => {
    localStorage.setItem(PROJECT_CHOICE_KEY, 'p-gone');
    const { result } = setup({ uid: 'u1', memberships: [A, B] });
    expect(result.current.currentProjectId).toBeNull();
  });

  it('re-validates when memberships change (revoked project drops out)', () => {
    const { result, rerender } = setup({ uid: 'u1', memberships: [A, B] });
    act(() => {
      result.current.switchProject('p-b');
    });
    rerender({ uid: 'u1', memberships: [A] });
    // The explicit choice is gone; nothing else was chosen → picker.
    expect(result.current.currentProjectId).toBeNull();
  });

  it('leave = explicit null: no auto-pick even with one membership', () => {
    const { result } = setup({ uid: 'u1', memberships: [A] });
    expect(result.current.currentProjectId).toBe('p-a');
    act(() => {
      result.current.setCurrentProject(null);
    });
    expect(result.current.currentProjectId).toBeNull();
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
  });

  it('sign-out clears the selection and the hint; the next uid starts fresh', () => {
    const { result, rerender } = setup({ uid: 'u1', memberships: [A, B] });
    act(() => {
      result.current.switchProject('p-b');
    });
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe('p-b');

    rerender({ uid: null, memberships: [] });
    expect(result.current.currentProjectId).toBeNull();
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();

    // Another user who is ALSO a member of p-b must not inherit u1's choice.
    rerender({ uid: 'u2', memberships: [A, B] });
    expect(result.current.currentProjectId).toBeNull();
  });

  it('a uid switch without sign-out never shows the previous choice', () => {
    const { result, rerender } = setup({ uid: 'u1', memberships: [A, B] });
    act(() => {
      result.current.switchProject('p-a');
    });
    localStorage.removeItem(PROJECT_CHOICE_KEY);
    rerender({ uid: 'u2', memberships: [A, B] });
    expect(result.current.currentProjectId).toBeNull();
  });

  it('follows a choice made in another tab', () => {
    const { result } = setup({ uid: 'u1', memberships: [A, B] });
    act(() => {
      localStorage.setItem(PROJECT_CHOICE_KEY, 'p-b');
      window.dispatchEvent(new StorageEvent('storage', { key: PROJECT_CHOICE_KEY }));
    });
    expect(result.current.currentProjectId).toBe('p-b');
  });
});

describe('demo provider', () => {
  function Probe() {
    const id = useProjectId();
    const { switchProject, setCurrentProject } = useProjectSelection();
    return (
      <div>
        <span data-testid="pid">{id ?? '-'}</span>
        <button data-testid="other" onClick={() => switchProject('p-other')} />
        <button data-testid="leave" onClick={() => setCurrentProject(null)} />
      </div>
    );
  }

  it('resolves DEMO_PROJECT_ID, refuses other projects, and can be left', () => {
    vi.stubEnv('VITE_FF_DEMO_AUTH', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(DEMO_PROJECT_ID).toBe('default-project');
    expect(screen.getByTestId('pid').textContent).toBe(DEMO_PROJECT_ID);
    act(() => screen.getByTestId('other').click());
    expect(screen.getByTestId('pid').textContent).toBe(DEMO_PROJECT_ID);
    act(() => screen.getByTestId('leave').click());
    expect(screen.getByTestId('pid').textContent).toBe('-');
  });
});

describe('no project → no writes', () => {
  class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    render() {
      return this.state.error ? <span data-testid="err">{this.state.error.name}</span> : this.props.children;
    }
  }
  function Writer() {
    return <span data-testid="pid">{useRequiredProjectId()}</span>;
  }

  it('useRequiredProjectId returns the id when a project is active', () => {
    vi.stubEnv('VITE_FF_DEMO_AUTH', 'true');
    render(
      <AuthProvider>
        <Writer />
      </AuthProvider>,
    );
    expect(screen.getByTestId('pid').textContent).toBe(DEMO_PROJECT_ID);
  });

  it('useRequiredProjectId throws NoActiveProjectError without a project', () => {
    vi.stubEnv('VITE_FF_DEMO_AUTH', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function LeaveThenWrite() {
      const { setCurrentProject, currentProjectId } = useProjectSelection();
      return currentProjectId ? (
        <button data-testid="leave" onClick={() => setCurrentProject(null)} />
      ) : (
        <Writer />
      );
    }
    render(
      <AuthProvider>
        <Catch>
          <LeaveThenWrite />
        </Catch>
      </AuthProvider>,
    );
    act(() => screen.getByTestId('leave').click());
    expect(screen.getByTestId('err').textContent).toBe('NoActiveProjectError');
  });

  it('requireProjectId asserts inside handlers', () => {
    expect(requireProjectId('p-a')).toBe('p-a');
    expect(() => requireProjectId(undefined)).toThrow(NoActiveProjectError);
    expect(() => requireProjectId(null)).toThrow(NoActiveProjectError);
  });
});
