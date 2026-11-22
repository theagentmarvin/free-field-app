import { useEffect, useState, type ReactNode } from "react";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import type { FirebaseApp } from "firebase/app";

import { useAuthContext, useIsAdmin } from "@ff/auth";
import { db as localDb } from "@ff/data/db/database";
import {
  createSyncEngine,
  registerBlobMissHandler,
  type SyncEngine,
  type SyncEvent,
} from "@ff/sync";
import { createFirestoreRemote, createStorageTransport } from "@ff/sync/firebase";

/**
 * Phase 1c/1d web mount: runs the shared headless sync engine (@ff/sync)
 * for the CURRENT project and shows the admin's one-time "Publish N local
 * buildings" prompt (docs/SPEC-PHASE-1.md §7 step 2). Lives in this package
 * only because apps/settings/package.json is Architect-owned; the engine
 * itself has no React.
 */

const engines = new WeakMap<object, { uid: string; engine: SyncEngine }>();

export function getWebSyncEngine(app: FirebaseApp, uid: string): SyncEngine {
  const hit = engines.get(app);
  if (hit && hit.uid === uid) return hit.engine;
  hit?.engine.dispose();
  const engine = createSyncEngine({
    db: localDb,
    remote: createFirestoreRemote(getFirestore(app)),
    transport: createStorageTransport(getStorage(app)),
    uid,
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  });
  registerBlobMissHandler(engine); // lazy .frag / PDF download on first open
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void engine.notifyOnline());
  }
  engines.set(app, { uid, engine });
  return engine;
}

export interface ProjectSyncMountProps {
  projectId: string | null | undefined;
  projectName?: string;
  /** False while the one-time local re-key is still running. */
  ready?: boolean;
}

export function ProjectSyncMount({ projectId, projectName, ready = true }: ProjectSyncMountProps): ReactNode {
  const { app, isDemo, user } = useAuthContext();
  const isAdmin = useIsAdmin();
  const uid = user?.uid ?? null;
  const [offer, setOffer] = useState<{ buildings: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isDemo || !uid || !projectId || !ready) return;
    const engine = getWebSyncEngine(app, uid);
    const off = engine.subscribe((e: SyncEvent) => {
      if (e.type === "publish-available" && e.projectId === projectId) setOffer({ buildings: e.buildings });
    });
    setOffer(null);
    engine.start(projectId, { canWrite: isAdmin }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[ff] sync failed to start", err);
    });
    return () => {
      off();
      engine.stop();
    };
  }, [app, isDemo, uid, projectId, ready, isAdmin]);

  if (!offer || !isAdmin || isDemo || !uid) return null;
  const engine = getWebSyncEngine(app, uid);
  const close = () => setOffer(null);
  return (
    <div role="alertdialog" aria-label="Publish local buildings" data-testid="publish-local-prompt"
      style={{ position: "fixed", bottom: 16, right: 16, zIndex: 1000, maxWidth: 360, padding: 16,
        background: "#fff", color: "#111", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}>
      <p style={{ margin: "0 0 12px" }}>
        Publish {offer.buildings} local building{offer.buildings === 1 ? "" : "s"} to {projectName ?? "this project"}?
        Everyone on the project will see them, and the files upload now.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" disabled={busy} onClick={() => { void engine.declinePublish(); close(); }}>Keep local</button>
        <button type="button" disabled={busy} onClick={() => { setBusy(true); void engine.publishLocal().finally(() => { setBusy(false); close(); }); }}>
          Publish
        </button>
      </div>
    </div>
  );
}
