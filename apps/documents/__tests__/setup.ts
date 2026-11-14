// apps/documents — Vitest setup.
//
// Mirrors apps/models/__tests__/setup.ts so the Documents module
// gets the same jsdom + IndexedDB + Blob/File polyfills Settings
// and Models already have. Any future test that touches Dexie,
// file uploads, or the PdfViewer pipeline should work out of the
// box.
//
// Critical pieces:
//  - fake-indexeddb/auto gives Dexie a working IndexedDB in jsdom.
//  - Node's native Blob/File replace jsdom's incomplete ones (Dexie
//    calls .arrayBuffer() on blobs).
//  - vitest globals (describe/it/expect) are enabled in tsconfig via
//    "types": ["vitest/globals", "node"], so tests don't need to
//    import them.
//  - @ff/auth shim: `useDocumentsGroups` reads the current project
//    id through `useProjectId()` (Dexie v9 project scoping), and the
//    real hook resolves it from Firebase custom claims via
//    <AuthProvider>. A unit test has neither Firebase config nor a
//    signed-in user, so the real hook throws
//    "useAuthContext must be used within <AuthProvider>".
//    The shim below provides the same module surface with a
//    deterministic project context — the same project id the tests
//    seed their Dexie rows with ("default-project").
//
// IMPORTANT: `vi.mock(...)` calls must live at the top of the file
// (above any `import` that transitively touches the mocked module).
// Vitest hoists vi.mock calls automatically, but the factory
// references the mocked module path so the order matters for
// readability and for any non-hoisted side effects.

import { vi } from "vitest";

// ── @ff/auth shim ───────────────────────────────────────────────
//
// The real @ff/auth entry point imports firebase/app, firebase/auth,
// firebase/firestore, … and boots a Firebase app inside
// <AuthProvider>. None of that exists in a unit test, so the whole
// module is replaced by a deterministic stub:
//
//   - useProjectId()      → "default-project" (matches the
//                            projectId the documents tests seed).
//   - useCurrentProject() → { id, role } for the same project.
//   - useAuth()           → a signed-in, claims-loaded user.
//   - useIsAdmin()        → true (the documents surface is
//                            read-only for members AND admins, so
//                            the role doesn't change what renders).
//   - the guards + AuthProvider → pass-through wrappers.
//
// Only `useProjectId` is actually consumed by apps/documents today
// (see src/hooks/useDocumentsGroups.ts); the rest of the surface is
// provided so a future consumer doesn't hit "No <X> export is
// defined on the @ff/auth mock".
vi.mock("@ff/auth", () => {
  const PROJECT_ID = "default-project";
  const currentProject = { id: PROJECT_ID, role: "admin" };
  const user = {
    uid: "test-user",
    email: "test@example.com",
    emailVerified: true,
    claims: { currentProject },
  };
  const passThrough = ({ children }: { children?: unknown }) => children;
  return {
    AuthProvider: passThrough,
    useAuthContext: () => ({
      app: {},
      auth: {},
    }),
    useAuth: () => ({
      user,
      firebaseUser: user,
      loading: false,
      error: null,
    }),
    useIsAdmin: () => true,
    useCurrentProject: () => currentProject,
    // Tests flip `globalThis.__ffNoProject = true` to simulate "no project".
    useProjectId: () =>
      (globalThis as { __ffNoProject?: boolean }).__ffNoProject ? undefined : PROJECT_ID,
    requireProjectId: (id: string | null | undefined) => {
      if (!id) throw new Error("No active project");
      return id;
    },
    useRequiredProjectId: () => PROJECT_ID,
    RequireAuth: passThrough,
    RequireAdmin: passThrough,
    RequireProjectMember: passThrough,
    runTenantCheck: () => undefined,
  };
});

import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

const { Blob: NodeBlob, File: NodeFile } = await import("node:buffer");
if (typeof globalThis.Blob !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Blob = NodeBlob;
}
if (typeof globalThis.File !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).File = NodeFile;
}
