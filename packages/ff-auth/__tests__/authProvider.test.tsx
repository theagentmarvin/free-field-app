// packages/ff-auth — <AuthProvider> + hooks + guards with a mocked Firebase.
//
// Covers wave-63 review findings:
//   - user / claims / project are resolved ONCE in the provider
//     (one auth listener, one token fetch, one project listener) no
//     matter how many hook consumers render;
//   - sign-out → sign-in: claims are keyed by uid, so the second
//     sign-in never sees loading=false with stale/empty claims;
//   - refreshClaims() publishes fresh claims to every consumer;
//   - Phase 1b: memberships come from ONE collection-group listener on the
//     user's active member docs (several projects), names from one project
//     doc listener each; role comes from the membership of the CURRENT
//     project; listener errors surface as an error + retry screen; the
//     transitional `currentProject` claim is aligned via setActiveProject;
//   - a broken Firebase config renders a readable error screen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Listener = (user: unknown) => void;

interface Call {
  kind: 'members' | 'project';
  id: string;
  next: (snap: unknown) => void;
  error: (err: Error) => void;
  unsubscribed: boolean;
}

const h = vi.hoisted(() => {
  const state = {
    authListeners: [] as Array<(u: unknown) => void>,
    currentUser: null as null | { uid: string; email: string; emailVerified: boolean },
    claimsByUid: {} as Record<string, Record<string, unknown>>,
    pendingTokens: [] as Array<{ uid: string; resolve: () => void }>,
    autoResolveTokens: true,
    calls: [] as Array<{
      kind: 'members' | 'project';
      id: string;
      next: (snap: unknown) => void;
      error: (err: Error) => void;
      unsubscribed: boolean;
    }>,
    callable: [] as Array<{ name: string; data: unknown }>,
    callableImpl: null as null | ((name: string, data: unknown) => Promise<unknown>),
  };
  return {
    state,
    getIdTokenResult: vi.fn(),
    onAuthStateChanged: vi.fn(),
    signOut: vi.fn(),
    onSnapshot: vi.fn(),
  };
});

vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: () => ({ name: 'app' }),
  getApp: () => ({ options: { projectId: 'ff-test' } }),
}));

vi.mock('firebase/auth', () => ({
  getAuth: () => ({
    get currentUser() {
      return h.state.currentUser;
    },
  }),
  connectAuthEmulator: vi.fn(),
  getIdTokenResult: h.getIdTokenResult,
  onAuthStateChanged: h.onAuthStateChanged,
  signOut: h.signOut,
}));

vi.mock('firebase/firestore', () => ({
  connectFirestoreEmulator: vi.fn(),
  getFirestore: () => ({}),
  doc: (_db: unknown, _col: string, id: string) => ({ kind: 'project', id }),
  collectionGroup: (_db: unknown, name: string) => ({ kind: 'group', name, filters: [] as unknown[] }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (base: { kind: string; name: string }, ...filters: unknown[]) => ({
    kind: 'members',
    group: base.name,
    filters,
  }),
  onSnapshot: h.onSnapshot,
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: (_fns: unknown, name: string) => async (data: unknown) => {
    h.state.callable.push({ name, data });
    if (h.state.callableImpl) return { data: await h.state.callableImpl(name, data) };
    return { data: {} };
  },
}));

vi.mock('firebase/storage', () => ({
  getStorage: () => ({}),
  connectStorageEmulator: vi.fn(),
}));

vi.mock('@ff/firestore', () => ({
  initFirestore: () => ({}),
}));

import {
  AuthProvider,
  RequireAdmin,
  RequireAuth,
  RequireProjectMember,
  PROJECT_CHOICE_KEY,
  useAuth,
  useCurrentProject,
  useIsAdmin,
  useProjectId,
  useProjectSelection,
  useRole,
} from '../src';

const FIREBASE_ENV = {
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_AUTH_DOMAIN: 'd',
  VITE_FIREBASE_PROJECT_ID: 'ff-test',
  VITE_FIREBASE_STORAGE_BUCKET: 'b',
  VITE_FIREBASE_MESSAGING_SENDER_ID: 'm',
  VITE_FIREBASE_APP_ID: 'a',
  VITE_EXPECTED_FIREBASE_PROJECT_ID: 'ff-test',
};

function stubFirebaseEnv(): void {
  vi.stubEnv('VITE_FF_DEMO_AUTH', 'false');
  for (const [k, v] of Object.entries(FIREBASE_ENV)) vi.stubEnv(k, v);
}

function emitAuth(user: { uid: string; email: string } | null): void {
  h.state.currentUser = user ? { ...user, emailVerified: true } : null;
  act(() => {
    for (const l of h.state.authListeners) l(h.state.currentUser);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const memberCalls = (): Call[] => h.state.calls.filter((c) => c.kind === 'members');
const projectCalls = (id?: string): Call[] =>
  h.state.calls.filter((c) => c.kind === 'project' && (id === undefined || c.id === id));

/** Deliver a membership snapshot: the user's ACTIVE member docs. */
function emitMembers(rows: Array<{ pid: string; role: string }>, call = memberCalls().at(-1)!): void {
  act(() =>
    call.next({
      docs: rows.map((r) => ({
        ref: { parent: { parent: { id: r.pid } } },
        data: () => ({ role: r.role }),
      })),
    }),
  );
}

function emitName(pid: string, name: string): void {
  act(() => projectCalls(pid).at(-1)!.next({ data: () => ({ name }) }));
}

beforeEach(() => {
  stubFirebaseEnv();
  localStorage.clear();
  h.state.authListeners = [];
  h.state.currentUser = null;
  h.state.claimsByUid = {};
  h.state.pendingTokens = [];
  h.state.autoResolveTokens = true;
  h.state.calls = [];
  h.state.callable = [];
  h.state.callableImpl = null;

  h.onAuthStateChanged.mockReset().mockImplementation((_auth: unknown, cb: Listener) => {
    h.state.authListeners.push(cb);
    return () => {
      h.state.authListeners = h.state.authListeners.filter((l) => l !== cb);
    };
  });
  h.getIdTokenResult.mockReset().mockImplementation((user: { uid: string }) => {
    const result = { claims: h.state.claimsByUid[user.uid] ?? {} };
    if (h.state.autoResolveTokens) return Promise.resolve(result);
    return new Promise((resolve) => {
      h.state.pendingTokens.push({ uid: user.uid, resolve: () => resolve(result) });
    });
  });
  h.signOut.mockReset().mockImplementation(async () => {
    emitAuth(null);
  });
  h.onSnapshot.mockReset().mockImplementation(
    (ref: { kind: 'members' | 'project'; id?: string }, next: Call['next'], error: Call['error']) => {
      const entry: Call = { kind: ref.kind, id: ref.id ?? '', next, error, unsubscribed: false };
      h.state.calls.push(entry);
      return () => {
        entry.unsubscribed = true;
      };
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Records every (user, loading, claims) tuple a consumer renders. */
function Probe({ log }: { log: Array<{ uid: string | null; loading: boolean; project: string | null }> }) {
  const { user, loading } = useAuth();
  log.push({
    uid: user?.uid ?? null,
    loading,
    project: user?.claims.currentProject?.id ?? null,
  });
  return (
    <div data-testid="probe">
      {loading ? 'loading' : user ? `${user.uid}:${user.claims.currentProject?.id ?? '-'}` : 'signed-out'}
    </div>
  );
}

function ProjectProbe() {
  const project = useCurrentProject();
  const admin = useIsAdmin();
  const role = useRole();
  return (
    <div data-testid="project">
      {project === undefined
        ? 'pending'
        : project === null
          ? 'none'
          : `${project.id}:${project.name ?? ''}:${admin}:${role}`}
    </div>
  );
}

describe('<AuthProvider> (real mode, mocked Firebase)', () => {
  it('resolves auth, claims and memberships once for many consumers', async () => {
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'member' } };
    const log: Array<{ uid: string | null; loading: boolean; project: string | null }> = [];
    render(
      <AuthProvider>
        {Array.from({ length: 12 }, (_, i) => (
          <Probe key={i} log={log} />
        ))}
        <ProjectProbe />
        <ProjectProbe />
      </AuthProvider>,
    );
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();

    expect(h.onAuthStateChanged).toHaveBeenCalledTimes(1);
    expect(h.getIdTokenResult).toHaveBeenCalledTimes(1);
    expect(memberCalls()).toHaveLength(1);
    expect(screen.getAllByTestId('probe')[0].textContent).toContain('u1:p1');

    emitMembers([{ pid: 'p1', role: 'admin' }]);
    expect(projectCalls()).toHaveLength(1);
    emitName('p1', 'Tower');
    // Role comes from the MEMBER DOC (admin), not from the member-role claim above.
    expect(screen.getAllByTestId('project')[0].textContent).toBe('p1:Tower:true:admin');
  });

  it('sign-out → sign-in never exposes loading=false with stale or empty claims', async () => {
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'member' } };
    h.state.claimsByUid.u2 = { currentProject: { id: 'p2', role: 'admin' } };
    const log: Array<{ uid: string | null; loading: boolean; project: string | null }> = [];
    render(
      <AuthProvider>
        <Probe log={log} />
      </AuthProvider>,
    );

    emitAuth({ uid: 'u1', email: 'one@x.test' });
    await flush();
    expect(screen.getByTestId('probe').textContent).toContain('u1:p1');

    emitAuth(null);
    expect(screen.getByTestId('probe').textContent).toContain('signed-out');

    h.state.autoResolveTokens = false;
    emitAuth({ uid: 'u2', email: 'two@x.test' });
    expect(screen.getByTestId('probe').textContent).toContain('loading');

    await act(async () => {
      h.state.pendingTokens.forEach((p) => p.resolve());
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe').textContent).toContain('u2:p2');

    for (const entry of log) {
      if (entry.uid && !entry.loading) {
        expect(entry.project).toBe(entry.uid === 'u1' ? 'p1' : 'p2');
      }
    }
  });

  it('refreshClaims() publishes fresh claims to every consumer', async () => {
    h.state.claimsByUid.u1 = {};
    let refresh: (() => Promise<unknown>) | null = null;
    function Refresher() {
      refresh = useAuth().refreshClaims;
      return null;
    }
    const log: Array<{ uid: string | null; loading: boolean; project: string | null }> = [];
    render(
      <AuthProvider>
        <Refresher />
        <Probe log={log} />
      </AuthProvider>,
    );
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    expect(screen.getByTestId('probe').textContent).toContain('u1:-');

    h.state.claimsByUid.u1 = { currentProject: { id: 'p9', role: 'member' } };
    await act(async () => {
      await refresh!();
    });
    expect(screen.getByTestId('probe').textContent).toContain('u1:p9');
  });

  it('renders a readable error screen when the Firebase config is missing', () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', '');
    render(
      <AuthProvider>
        <div data-testid="child" />
      </AuthProvider>,
    );
    expect(screen.getByTestId('auth-config-error').textContent).toContain(
      'Missing Firebase config: apiKey',
    );
    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('renders the tenant mismatch as an error screen', () => {
    vi.stubEnv('VITE_EXPECTED_FIREBASE_PROJECT_ID', 'someone-else');
    render(
      <AuthProvider>
        <div data-testid="child" />
      </AuthProvider>,
    );
    expect(screen.getByTestId('auth-config-error').textContent).toContain('TenantMismatchError');
    expect(screen.queryByTestId('child')).toBeNull();
  });
});

describe('memberships and current project (real mode, Phase 1b)', () => {
  function SelectionProbe() {
    const { memberships, switchProject, currentProjectId: id } = useProjectSelection();
    const hookId = useProjectId();
    const { signOut } = useAuth();
    return (
      <div>
        <ProjectProbe />
        <span data-testid="pid">{id === undefined ? 'undef' : (id ?? 'null')}</span>
        <span data-testid="hook-pid">{hookId ?? '-'}</span>
        <span data-testid="memberships">
          {memberships === undefined ? 'pending' : memberships.map((m) => `${m.id}=${m.role}`).join(',')}
        </span>
        <button data-testid="switch-intruder" onClick={() => switchProject('p-intruder')} />
        <button data-testid="switch-p1" onClick={() => switchProject('p1')} />
        <button data-testid="switch-p2" onClick={() => switchProject('p2')} />
        <button data-testid="sign-out" onClick={() => void signOut()} />
      </div>
    );
  }

  async function signIn(uid = 'u1') {
    emitAuth({ uid, email: `${uid}@x.test` });
    await flush();
  }

  it('queries the collection group for the caller\'s ACTIVE member docs', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn('u1');
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
    expect(memberCalls()).toHaveLength(1);
    const q = h.onSnapshot.mock.calls[0][0];
    expect(q.group).toBe('members');
    expect(q.filters).toEqual([
      { field: 'uid', op: '==', value: 'u1' },
      { field: 'status', op: '==', value: 'active' },
    ]);
  });

  it('a single membership is auto-picked; its name arrives later without blocking', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    expect(screen.getByTestId('memberships').textContent).toBe('pending');
    expect(screen.getByTestId('pid').textContent).toBe('undef');

    emitMembers([{ pid: 'p1', role: 'member' }]);
    expect(screen.getByTestId('memberships').textContent).toBe('p1=member');
    expect(screen.getByTestId('pid').textContent).toBe('p1');
    expect(screen.getByTestId('project').textContent).toBe('p1::false:viewer');

    emitName('p1', 'Tower');
    expect(screen.getByTestId('project').textContent).toBe('p1:Tower:false:viewer');
  });

  it('several memberships and no hint: null (picker); the role follows the CHOSEN project', async () => {
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'admin' } };
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([
      { pid: 'p1', role: 'admin' },
      { pid: 'p2', role: 'member' },
    ]);
    expect(screen.getByTestId('pid').textContent).toBe('null');
    expect(screen.getByTestId('project').textContent).toBe('none');
    expect(projectCalls().map((c) => c.id).sort()).toEqual(['p1', 'p2']);

    act(() => screen.getByTestId('switch-p1').click());
    expect(screen.getByTestId('project').textContent).toContain('p1::true:admin');
    act(() => screen.getByTestId('switch-p2').click());
    expect(screen.getByTestId('pid').textContent).toBe('p2');
    expect(screen.getByTestId('project').textContent).toContain('p2::false:viewer');
  });

  it('validates switches against the memberships', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([{ pid: 'p1', role: 'member' }, { pid: 'p2', role: 'member' }]);
    act(() => screen.getByTestId('switch-p1').click());
    act(() => screen.getByTestId('switch-intruder').click());
    expect(screen.getByTestId('pid').textContent).toBe('p1');
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe('p1');
  });

  it('revocation: the member doc leaving the snapshot drops the project and sends the user to the picker', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([{ pid: 'p1', role: 'member' }, { pid: 'p2', role: 'member' }]);
    act(() => screen.getByTestId('switch-p2').click());
    expect(screen.getByTestId('pid').textContent).toBe('p2');

    emitMembers([{ pid: 'p1', role: 'member' }, { pid: 'p2', role: 'member' }].slice(0, 1));
    // p2 is gone: no explicit valid choice left and one membership remains,
    // but the user already chose explicitly this session → picker.
    expect(screen.getByTestId('pid').textContent).toBe('null');
    expect(projectCalls('p2').at(-1)!.unsubscribed).toBe(true);
  });

  it('a demotion in the member doc updates the role live (no token refresh)', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([{ pid: 'p1', role: 'admin' }]);
    expect(screen.getByTestId('project').textContent).toContain(':true:admin');
    const tokenCalls = h.getIdTokenResult.mock.calls.length;
    emitMembers([{ pid: 'p1', role: 'member' }]);
    expect(screen.getByTestId('project').textContent).toContain(':false:viewer');
    expect(h.getIdTokenResult.mock.calls.length).toBe(tokenCalls);
  });

  it('a user without memberships has memberships=[] and no project', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([]);
    expect(screen.getByTestId('memberships').textContent).toBe('');
    expect(screen.getByTestId('pid').textContent).toBe('null');
  });

  it('a stale previous-user snapshot never leaks into the next user (uid-keyed)', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn('u1');
    const first = memberCalls()[0];
    emitMembers([{ pid: 'p1', role: 'member' }], first);
    emitAuth(null);
    await signIn('u2');
    expect(screen.getByTestId('memberships').textContent).toBe('pending');
    // late delivery from u1's (cancelled) listener is ignored
    emitMembers([{ pid: 'p1', role: 'admin' }], first);
    expect(screen.getByTestId('memberships').textContent).toBe('pending');
  });

  it('clears the selection and the hint on sign-out', async () => {
    render(<AuthProvider><SelectionProbe /></AuthProvider>);
    await signIn();
    emitMembers([{ pid: 'p1', role: 'member' }, { pid: 'p2', role: 'member' }]);
    act(() => screen.getByTestId('switch-p1').click());
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe('p1');
    await act(async () => {
      screen.getByTestId('sign-out').click();
      await Promise.resolve();
    });
    expect(screen.getByTestId('pid').textContent).toBe('null');
    expect(screen.getByTestId('memberships').textContent).toBe('');
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
  });
});

describe('transitional claim alignment (setActiveProject)', () => {
  function Switcher() {
    const { switchProject, currentProjectId } = useProjectSelection();
    return (
      <div>
        <span data-testid="pid">{String(currentProjectId)}</span>
        <button data-testid="to-p2" onClick={() => switchProject('p2')} />
      </div>
    );
  }

  it('calls setActiveProject when the claim names another project, then refreshes claims', async () => {
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'admin' } };
    h.state.callableImpl = async () => {
      h.state.claimsByUid.u1 = { currentProject: { id: 'p2', role: 'member' } };
      return {};
    };
    const log: Array<{ uid: string | null; loading: boolean; project: string | null }> = [];
    render(<AuthProvider><Switcher /><Probe log={log} /></AuthProvider>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    emitMembers([{ pid: 'p1', role: 'admin' }, { pid: 'p2', role: 'member' }]);
    // p1 is the claim's project and nothing is chosen yet: no call.
    expect(h.state.callable).toHaveLength(0);

    act(() => screen.getByTestId('to-p2').click());
    await flush();
    expect(h.state.callable).toEqual([{ name: 'setActiveProject', data: { projectId: 'p2' } }]);
    expect(screen.getByTestId('probe').textContent).toContain('u1:p2');
  });

  it('does not call when the claim already matches, and does not loop on failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'member' } };
    h.state.callableImpl = async () => {
      throw new Error('offline');
    };
    render(<AuthProvider><Switcher /></AuthProvider>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    emitMembers([{ pid: 'p1', role: 'member' }, { pid: 'p2', role: 'member' }]);
    act(() => screen.getByTestId('to-p2').click());
    await flush();
    await flush();
    expect(h.state.callable).toHaveLength(1);
  });
});

describe('guards (real mode, mocked Firebase)', () => {
  function renderAt(path: string, element: React.ReactNode) {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/guarded" element={element} />
            <Route path="/sign-in" element={<div data-testid="sign-in" />} />
            <Route path="/needs-invitation" element={<div data-testid="needs-invitation" />} />
            <Route path="/models" element={<div data-testid="models" />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('RequireAuth redirects a signed-out user to /sign-in', async () => {
    renderAt('/guarded', <RequireAuth><div data-testid="inside" /></RequireAuth>);
    emitAuth(null);
    expect(screen.getByTestId('sign-in')).toBeTruthy();
  });

  it('RequireAdmin waits for the membership, then bounces a member to /models', async () => {
    h.state.claimsByUid.u1 = { currentProject: { id: 'p1', role: 'admin' } }; // claim says admin; doc says member
    renderAt('/guarded', <RequireAdmin><div data-testid="inside" /></RequireAdmin>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    // Memberships pending: no redirect decision yet.
    expect(screen.queryByTestId('models')).toBeNull();
    expect(screen.queryByTestId('inside')).toBeNull();
    emitMembers([{ pid: 'p1', role: 'member' }]);
    expect(screen.getByTestId('models')).toBeTruthy();
    expect(screen.queryByTestId('inside')).toBeNull();
  });

  it('RequireAdmin lets an admin of the CURRENT project through, per project', async () => {
    renderAt('/guarded', <RequireAdmin><div data-testid="inside" /></RequireAdmin>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    emitMembers([{ pid: 'p1', role: 'admin' }]);
    expect(screen.getByTestId('inside')).toBeTruthy();
  });

  it('RequireProjectMember sends a user without a membership to /needs-invitation', async () => {
    renderAt('/guarded', <RequireProjectMember><div data-testid="inside" /></RequireProjectMember>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    emitMembers([]);
    expect(screen.getByTestId('needs-invitation')).toBeTruthy();
  });

  it('RequireProjectMember shows an error + retry screen when the membership listener fails', async () => {
    renderAt('/guarded', <RequireProjectMember><div data-testid="inside" /></RequireProjectMember>);
    emitAuth({ uid: 'u1', email: 'a@x.test' });
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => memberCalls()[0].error(new Error('permission-denied')));
    expect(screen.getByTestId('project-load-error').textContent).toContain('permission-denied');

    fireEvent.click(screen.getByTestId('project-load-retry'));
    expect(memberCalls()).toHaveLength(2);
    expect(screen.queryByTestId('project-load-error')).toBeNull();
    emitMembers([{ pid: 'p1', role: 'member' }], memberCalls()[1]);
    expect(screen.getByTestId('inside')).toBeTruthy();
  });
});
