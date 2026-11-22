import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  getIdTokenResult,
  onAuthStateChanged,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  collectionGroup,
  connectFirestoreEmulator,
  doc,
  getFirestore,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { initFirestore } from '@ff/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { DEMO_PROJECT_ID, isDemoAuth } from './demo';
import { useDemoRole } from './hooks/useDemoRole';
import { useProjectSelectionState, type ProjectMembership } from './projectSelection';
import { runTenantCheck } from './tenant-check';
import type { AuthClaims, AuthUser, CurrentProject } from './types';

/** Cloud Functions region (VITE_FIREBASE_FUNCTIONS_REGION); unset = SDK default (us-central1). */
const FUNCTIONS_REGION: string | undefined =
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || undefined;

/** Emulator host (VITE_FIREBASE_EMULATOR_HOST), e.g. 10.0.2.2 for an Android emulator; default localhost. */
const EMULATOR_HOST: string = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || 'localhost';

/**
 * Firebase Auth context. Provided by <AuthProvider>; consumed by hooks
 * and guards in this package, and by route components in apps that need
 * direct access to the Auth or FirebaseApp instance.
 *
 * The provider is the ONE place that resolves the signed-in user, their
 * custom claims and the current project document. `useAuth()`,
 * `useCurrentProject()` and the guards only read this context, so every
 * consumer shares one auth listener, one token fetch and one Firestore
 * project listener.
 */
export interface AuthContextValue {
  app: FirebaseApp;
  auth: Auth;
  /**
   * True when the demo (mocked sign-in) mode is active. In demo mode the
   * Firebase app below is a stub — no Firebase backend is contacted.
   */
  isDemo: boolean;
  /**
   * Counter bumped whenever the demo role changes. Lets guards and
   * role-aware UI re-render when the "View as" toggle is flipped.
   */
  demoRoleVersion: number;

  /** Raw Firebase user (null when signed out or in demo mode). */
  firebaseUser: User | null;
  /** Resolved user + claims (synthetic identity in demo mode). */
  user: AuthUser | null;
  /** True until auth state AND the signed-in user's claims are known. */
  loading: boolean;
  /** Auth listener error, if any. */
  error: Error | undefined;

  /**
   * Projects the user belongs to: undefined while loading (or after a
   * listener error), [] when signed out or without any membership.
   * Phase 1b: the user's ACTIVE member docs, found with a collection-group
   * query on `members` (`uid == me`); `role` is the member doc's role for
   * that project and `name` comes from one project-doc listener each
   * (SPEC-PHASE-1 §2.1).
   */
  memberships: ProjectMembership[] | undefined;
  /**
   * THE current project id for the whole app (wave 65). undefined while
   * loading, null when signed out or nothing is chosen yet (the shell
   * shows the project picker), a membership id otherwise.
   */
  currentProjectId: string | null | undefined;
  /** Choose a project, or null to leave. Returns false for a non-membership. */
  setCurrentProject: (id: string | null) => boolean;
  /** Switch to another membership. Returns false for a non-membership. */
  switchProject: (id: string) => boolean;
  /**
   * Current project (the membership matching `currentProjectId`):
   * undefined while loading (or after a listener error), null when
   * signed out or no project is chosen, the project otherwise.
   */
  project: CurrentProject | null | undefined;
  /** Error from the membership listener (memberships / project are then undefined). */
  projectError: Error | null;
  /** Re-subscribe to the membership listener after an error. */
  retryProject: () => void;

  /**
   * Force a token refresh and return the fresh claims (also published
   * to every consumer). Used after server-side claim changes, e.g. a
   * redeemed invitation.
   */
  refreshClaims: () => Promise<AuthClaims>;
  /** Sign the current user out (no-op in demo mode). */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /**
   * How long the membership listener may stay silent (no cache hit, no
   * server answer) before the provider surfaces a `MembershipTimeoutError`
   * through `projectError`. Default `MEMBERSHIP_TIMEOUT_MS`; tests inject a
   * small value.
   */
  membershipTimeoutMs?: number;
}

/** Default silence budget of the first membership snapshot (~12 s). */
export const MEMBERSHIP_TIMEOUT_MS = 12_000;

/**
 * The membership listener produced nothing within the timeout: typically a
 * first sign-in on this device with no network (nothing cached to answer
 * from). The listener stays attached, so a late answer clears the error.
 */
export class MembershipTimeoutError extends Error {
  readonly code = 'membership-timeout';
  constructor() {
    super(
      "We couldn't reach the server to load your projects. If you're offline, " +
        'reconnect and try again. Once your projects have loaded on this device ' +
        'FreeField opens without waiting for the network.'
    );
    this.name = 'MembershipTimeoutError';
  }
}

/**
 * Demo-mode stand-ins for the Firebase app / auth instance.
 *
 * They exist so `useAuthContext()` consumers keep working without a
 * Firebase backend: `signOut` is a no-op and `getIdToken` resolves to
 * the literal string 'demo'. Nothing here talks to the network.
 */
const demoApp = {} as unknown as FirebaseApp;
const demoAuth = {
  currentUser: null,
  signOut: async () => undefined,
  getIdToken: async () => 'demo',
} as unknown as Auth;

const noopAsync = async (): Promise<void> => undefined;

/** Claims fetched for one specific uid (keyed so a stale uid never leaks). */
interface ClaimsEntry {
  uid: string;
  claims: AuthClaims;
}

/** Active member docs of one specific uid (keyed so a stale uid never leaks). */
interface MembershipRows {
  uid: string;
  rows: Array<{ id: string; role: string }>;
}
interface MembershipError {
  uid: string;
  error: Error;
}

interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
}

/**
 * Initialize Firebase exactly once from VITE_FIREBASE_* env vars
 * (injected at build time by Vite). Throws on a missing config or a
 * tenant mismatch; the provider turns that into a readable error
 * screen instead of a white screen.
 */
function initFirebase(): FirebaseHandles {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing Firebase config: ${missing.join(', ')}. ` +
        `Set VITE_FIREBASE_* env vars and rebuild. See docs/deploy/byo-firebase.md.`
    );
  }

  const existing = getApps()[0];
  const app = existing ?? initializeApp(config);
  const auth = getAuth(app);
  // D6 (task-39): FIRST Firestore contact must go through
  // initFirestore so the persistent (IndexedDB) local cache is on —
  // the cloud-first data plane assumes warm cached reads. Every
  // later getFirestore(app) call returns this same instance.
  const db = initFirestore(app);

  // Dev-mode emulator support (VITE_FIREBASE_USE_EMULATOR=true).
  // Auth emulator at <host>:9099, Firestore at <host>:8080,
  // Functions at <host>:5001, Storage at <host>:9199 (host =
  // VITE_FIREBASE_EMULATOR_HOST, default localhost). Only on the first init (StrictMode
  // runs the initializer twice; connecting twice throws).
  if (!existing && import.meta.env.VITE_FIREBASE_USE_EMULATOR === 'true') {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
    connectFunctionsEmulator(getFunctions(app, FUNCTIONS_REGION), EMULATOR_HOST, 5001);
    connectStorageEmulator(getStorage(app), EMULATOR_HOST, 9199);
  }

  // Tenant isolation guard (P0.3). Runs here, AFTER Firebase init,
  // so the runtime project ID is always available for comparison.
  runTenantCheck();

  return { app, auth };
}

/**
 * Initialize Firebase exactly once and expose {app, auth} plus the
 * resolved user, claims and current project via context.
 *
 * Per plan v3 §6.1: this is the single entry point of Firebase in FreeField.
 * All apps (settings, documents, models, linkview, users) consume the same
 * provider via apps/settings/src/shell/MainShell.tsx.
 *
 * Demo mode (plan v4 amendment v4.1): when VITE_FF_DEMO_AUTH=true we skip
 * Firebase initialization, the tenant-check AND the auth-state listener
 * entirely — the demo must boot with zero Firebase backend. The context
 * exposes a stub {app, auth} and a synthetic identity for the demo role.
 */
export function AuthProvider({ children, membershipTimeoutMs }: AuthProviderProps) {
  return isDemoAuth() ? (
    <DemoAuthProvider>{children}</DemoAuthProvider>
  ) : (
    <FirebaseAuthProvider membershipTimeoutMs={membershipTimeoutMs}>{children}</FirebaseAuthProvider>
  );
}

function DemoAuthProvider({ children }: AuthProviderProps) {
  const demoRole = useDemoRole();
  const [demoRoleVersion, setDemoRoleVersion] = useState(0);
  const [lastRole, setLastRole] = useState(demoRole);
  if (lastRole !== demoRole) {
    // Derived-state update during render (React-sanctioned pattern for
    // a local state): bump the counter whenever the role flips.
    setLastRole(demoRole);
    setDemoRoleVersion((v) => v + 1);
  }

  const uid = demoRole === 'admin' ? 'demo-admin' : 'demo-viewer';
  const memberships = useMemo<ProjectMembership[]>(
    () => [{ id: DEMO_PROJECT_ID, role: demoRole, name: 'Demo project' }],
    [demoRole]
  );
  const { currentProjectId, setCurrentProject, switchProject } = useProjectSelectionState(
    uid,
    memberships
  );

  const value = useMemo<AuthContextValue>(() => {
    // Synthetic identity. admin@demo is the demo admin ("you" in the
    // Users mock table), guest@demo the demo viewer.
    const user: AuthUser = {
      uid,
      email: demoRole === 'admin' ? 'admin@demo' : 'guest@demo',
      emailVerified: true,
      claims: { currentProject: { id: DEMO_PROJECT_ID, role: demoRole } },
    };
    return {
      app: demoApp,
      auth: demoAuth,
      isDemo: true,
      demoRoleVersion,
      firebaseUser: null,
      user,
      loading: false,
      error: undefined,
      memberships,
      currentProjectId,
      setCurrentProject,
      switchProject,
      project: memberships.find((m) => m.id === currentProjectId) ?? null,
      projectError: null,
      retryProject: () => undefined,
      refreshClaims: async () => user.claims,
      signOut: noopAsync,
    };
  }, [
    uid,
    demoRole,
    demoRoleVersion,
    memberships,
    currentProjectId,
    setCurrentProject,
    switchProject,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function FirebaseAuthProvider({ children, membershipTimeoutMs = MEMBERSHIP_TIMEOUT_MS }: AuthProviderProps) {
  // Init on first render (idempotent: getApps() reuses the app) so a
  // config error is caught here and rendered as a screen.
  const [init] = useState<{ handles: FirebaseHandles | null; error: Error | null }>(() => {
    try {
      return { handles: initFirebase(), error: null };
    } catch (err) {
      return { handles: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  });

  if (!init.handles) {
    return <AuthConfigErrorScreen error={init.error ?? new Error('Firebase failed to start')} />;
  }
  return (
    <FirebaseSession handles={init.handles} membershipTimeoutMs={membershipTimeoutMs}>
      {children}
    </FirebaseSession>
  );
}

function FirebaseSession({
  handles,
  children,
  membershipTimeoutMs,
}: {
  handles: FirebaseHandles;
  children: ReactNode;
  membershipTimeoutMs: number;
}) {
  const { app, auth } = handles;

  // ── auth state (ONE listener for the whole app) ──
  const [firebaseUser, setFirebaseUser] = useState<User | null>(auth.currentUser ?? null);
  const [authLoading, setAuthLoading] = useState<boolean>(auth.currentUser == null);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(
    () =>
      onAuthStateChanged(
        auth,
        (next) => {
          setFirebaseUser(next);
          setAuthLoading(false);
        },
        (err) => {
          setError(err);
          setAuthLoading(false);
        }
      ),
    [auth]
  );

  // ── claims, keyed by uid ──
  // `claimsLoading` is DERIVED: true whenever the signed-in uid has no
  // claims entry yet. Signing out and back in (same or another uid)
  // can never see a stale "loaded" flag or another user's claims.
  const [claimsEntry, setClaimsEntry] = useState<ClaimsEntry | null>(null);
  const uid = firebaseUser?.uid ?? null;

  useEffect(() => {
    if (!firebaseUser) {
      setClaimsEntry(null);
      return;
    }
    let cancelled = false;
    // Force-refresh once per sign-in so claims set server-side after
    // the token was minted are picked up.
    getIdTokenResult(firebaseUser, true)
      .then((result) => {
        if (cancelled) return;
        setClaimsEntry({ uid: firebaseUser.uid, claims: result.claims as AuthClaims });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[AuthProvider] failed to fetch claims', err);
        setClaimsEntry({ uid: firebaseUser.uid, claims: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser]);

  const claims: AuthClaims | null =
    uid !== null && claimsEntry !== null && claimsEntry.uid === uid ? claimsEntry.claims : null;
  const claimsLoading = uid !== null && claims === null;
  const loading = authLoading || claimsLoading;

  const refreshClaims = useCallback(async (): Promise<AuthClaims> => {
    const current = auth.currentUser;
    if (!current) return {};
    const result = await getIdTokenResult(current, true);
    const fresh = result.claims as AuthClaims;
    setClaimsEntry({ uid: current.uid, claims: fresh });
    return fresh;
  }, [auth]);

  const signOut = useCallback(async (): Promise<void> => {
    await firebaseSignOut(auth);
  }, [auth]);

  const user = useMemo<AuthUser | null>(
    () =>
      firebaseUser
        ? {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            emailVerified: firebaseUser.emailVerified,
            claims: claims ?? {},
          }
        : null,
    [firebaseUser, claims]
  );

  // ── memberships (Phase 1b) ──
  // ONE collection-group listener on the user's ACTIVE member docs
  // (rules allow it because the doc's `uid` field names the caller), plus
  // one project-doc listener per membership for the display name.
  // Everything is keyed by uid, so a previous user's memberships can never
  // be shown to the next one.
  const [rowsEntry, setRowsEntry] = useState<MembershipRows | null>(null);
  const [errorEntry, setErrorEntry] = useState<MembershipError | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retryProject = useCallback(() => {
    setErrorEntry(null);
    setRetryCount((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    const db = getFirestore(app);
    const q = query(
      collectionGroup(db, 'members'),
      where('uid', '==', uid),
      where('status', '==', 'active')
    );
    // Silence watchdog: a cached returning user gets a snapshot from the
    // persistent cache in milliseconds and never trips this; a first boot
    // with no network/cache would otherwise wait forever.
    const timer = setTimeout(() => {
      if (cancelled) return;
      console.warn('[AuthProvider] membership listener silent; surfacing a timeout error');
      setErrorEntry({ uid, error: new MembershipTimeoutError() });
    }, membershipTimeoutMs);
    const unsub = onSnapshot(
      q,
      // Metadata changes are needed so a server answer that matches an empty
      // cache result still fires (fromCache true → false).
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        // A first boot on this device with an unreachable backend gets an
        // EMPTY snapshot from the (empty) persistent cache. That is "unknown",
        // not "no memberships": keep waiting for the server or the timeout
        // instead of routing the user to the needs-invitation screen. A
        // non-empty cached snapshot is trusted (returning users open offline).
        if (snap.metadata?.fromCache === true && snap.docs.length === 0) return;
        clearTimeout(timer);
        // A late answer heals a timeout error (a real listener error stays).
        setErrorEntry((e) => (e && e.error instanceof MembershipTimeoutError ? null : e));
        const rows: Array<{ id: string; role: string }> = [];
        for (const d of snap.docs) {
          const id = d.ref.parent.parent?.id;
          if (id) rows.push({ id, role: String(d.data().role ?? '') });
        }
        rows.sort((a, b) => a.id.localeCompare(b.id));
        setRowsEntry({ uid, rows });
      },
      (err) => {
        if (cancelled) return;
        clearTimeout(timer);
        console.error('[AuthProvider] membership listener error', err);
        setErrorEntry({ uid, error: err });
      }
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub();
    };
  }, [app, uid, retryCount, membershipTimeoutMs]);

  const rows = uid !== null && rowsEntry !== null && rowsEntry.uid === uid ? rowsEntry.rows : null;
  const projectIdsKey = rows ? rows.map((r) => r.id).join('\n') : '';
  const [names, setNames] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    if (!projectIdsKey) return;
    let cancelled = false;
    const db = getFirestore(app);
    const unsubs = projectIdsKey.split('\n').map((id) =>
      onSnapshot(
        doc(db, 'projects', id),
        (snap) => {
          if (cancelled) return;
          const name = snap.data()?.name as string | undefined;
          setNames((prev) => (prev[id] === name ? prev : { ...prev, [id]: name }));
        },
        (err) => {
          // A name is cosmetic: the membership itself is already known.
          console.error(`[AuthProvider] project listener error (${id})`, err);
        }
      )
    );
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [app, projectIdsKey]);

  let projectError: Error | null = null;
  let membershipList: ProjectMembership[] | undefined;
  if (loading) {
    membershipList = undefined;
  } else if (!firebaseUser) {
    membershipList = [];
  } else if (errorEntry !== null && errorEntry.uid === uid) {
    membershipList = undefined;
    projectError = errorEntry.error;
  } else if (rows !== null) {
    membershipList = rows.map((r) => ({ id: r.id, role: r.role, name: names[r.id] }));
  } else {
    membershipList = undefined;
  }
  // Stable identity unless the content changes (names arrive one by one).
  const membershipsKey =
    membershipList === undefined
      ? null
      : membershipList.map((m) => `${m.id}|${m.role}|${m.name ?? ''}`).join('\n');
  // Keyed on the content string (react-hooks/exhaustive-deps is not enabled in this package).
  const memberships = useMemo(() => membershipList, [membershipsKey]);

  // ── THE current project (wave 65) ──
  const { currentProjectId, setCurrentProject, switchProject } = useProjectSelectionState(
    uid,
    memberships
  );

  // Phase 1b transition (dropped in 1e): rules no longer read claims, but
  // the `currentProject` claim still keys the profile-read rule and is the
  // admin callables' fallback project. Keep it equal to the selection.
  const claimSyncRef = useRef<string | null>(null);
  const claimProjectId = claims?.currentProject?.id ?? null;
  useEffect(() => {
    if (!uid || !currentProjectId || claims === null) return;
    if (claimProjectId === currentProjectId) return;
    const key = `${uid}|${currentProjectId}`;
    if (claimSyncRef.current === key) return;
    claimSyncRef.current = key;
    httpsCallable<{ projectId: string }, unknown>(
      getFunctions(app, FUNCTIONS_REGION),
      'setActiveProject'
    )({ projectId: currentProjectId })
      .then(() => refreshClaims())
      .catch((err) => {
        console.warn('[AuthProvider] could not align the active-project claim', err);
        claimSyncRef.current = null;
      });
  }, [app, uid, currentProjectId, claims, claimProjectId, refreshClaims]);

  let project: CurrentProject | null | undefined;
  if (memberships === undefined || currentProjectId === undefined) {
    project = undefined;
  } else if (currentProjectId === null) {
    project = null;
  } else {
    project = memberships.find((m) => m.id === currentProjectId) ?? null;
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      app,
      auth,
      isDemo: false,
      demoRoleVersion: 0,
      firebaseUser,
      user,
      loading,
      error,
      memberships,
      currentProjectId,
      setCurrentProject,
      switchProject,
      project,
      projectError,
      retryProject,
      refreshClaims,
      signOut,
    }),
    [
      app,
      auth,
      firebaseUser,
      user,
      loading,
      error,
      memberships,
      currentProjectId,
      setCurrentProject,
      switchProject,
      project,
      projectError,
      retryProject,
      refreshClaims,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Readable boot error (missing VITE_FIREBASE_* config, tenant mismatch).
 * Replaces the white screen an uncaught init error used to produce.
 */
export function AuthConfigErrorScreen({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      data-testid="auth-config-error"
      style={{
        padding: 32,
        maxWidth: 640,
        margin: '10vh auto',
        fontFamily: 'var(--ff-font-stack, system-ui, sans-serif)',
        color: 'var(--ff-text-primary, #111)',
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>FreeField can&rsquo;t start</h1>
      <p style={{ marginBottom: 12 }}>
        The Firebase configuration for this deployment is missing or does not match. Ask
        whoever deployed FreeField to check the environment settings.
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: 'var(--ff-bg-panel, #f4f4f5)',
          padding: 12,
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        {error.name !== 'Error' ? `${error.name}: ` : ''}
        {error.message}
      </pre>
    </div>
  );
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within <AuthProvider>');
  }
  return ctx;
}
