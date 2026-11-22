import { useEffect, useRef, useState } from "react";
import { getDoc, getDocs, query, where, type Firestore } from "firebase/firestore";

import { useAuth } from "@ff/auth";
import { membersCollection, userDoc } from "@ff/firestore";

import { DEMO_PEOPLE } from "./tasksSource";

/**
 * Actor + assignee-roster plumbing shared by the compose sheet
 * (TasksApp) and the 3D pin (TaskPin) — the same people fetch, one
 * implementation. In cloud mode the hook loads the active roster itself
 * once a signed-in user + project are known (`members` is null only
 * while that load is in flight or if it failed); `ensureMembers()`
 * stays as an idempotent retry/await hook for callers.
 *
 * Demo mode hands this hook a null Firestore — it then returns the
 * static demo roster + demo admin actor, so the assignee picker and
 * "composed by" stamps still work login-free.
 */

export interface TaskPerson {
  uid: string;
  name: string;
}

async function loadMembers(db: Firestore, projectId: string): Promise<TaskPerson[]> {
  const snap = await getDocs(
    query(membersCollection(db, projectId), where("status", "==", "active"))
  );
  return Promise.all(
    snap.docs.map(async (d) => {
      const s = await getDoc(userDoc(db, d.id));
      return { uid: d.id, name: s.data()?.displayName ?? d.id };
    })
  );
}

export function useTaskPeople(
  db: Firestore | null,
  projectId: string | undefined
): { actor: TaskPerson; members: TaskPerson[] | null; ensureMembers: () => Promise<void> } {
  const { user } = useAuth();
  const [profileName, setProfileName] = useState<string | null>(null);
  const [members, setMembers] = useState<TaskPerson[] | null>(null);
  const inflight = useRef<{ key: string; promise: Promise<void> } | null>(null);

  useEffect(() => {
    if (!db || !user) return;
    void getDoc(userDoc(db, user.uid)).then((s) => setProfileName(s.data()?.displayName ?? null));
  }, [db, user]);

  // Members belong to one project: drop them when it changes.
  useEffect(() => {
    setMembers(null);
    inflight.current = null;
  }, [db, projectId]);

  async function ensureMembers(): Promise<void> {
    if (members || !db || !projectId) return;
    if (inflight.current?.key === `${projectId}`) return inflight.current.promise;
    const key = `${projectId}`;
    const promise = loadMembers(db, projectId)
      .then((users) => {
        if (inflight.current?.key === key) setMembers(users);
      })
      .catch(() => {
        /* offline / rules: stay null; a later call retries */
      })
      .finally(() => {
        if (inflight.current?.promise === promise) inflight.current = null;
      });
    inflight.current = { key, promise };
    return promise;
  }

  // Cloud mode: load the roster without waiting for a caller.
  const ensureRef = useRef(ensureMembers);
  ensureRef.current = ensureMembers;
  useEffect(() => {
    if (!db || !projectId || !user) return;
    void ensureRef.current();
  }, [db, projectId, user]);

  if (!db) {
    return {
      actor: { uid: user?.uid ?? "demo-admin", name: "Alex Rivera" },
      members: [...DEMO_PEOPLE],
      ensureMembers: async () => undefined,
    };
  }

  return {
    actor: { uid: user?.uid ?? "", name: profileName ?? user?.email ?? "me" },
    members,
    ensureMembers,
  };
}