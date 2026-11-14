import { useEffect, useState } from "react";
import { getDoc, getDocs, query, where, type Firestore } from "firebase/firestore";

import { useAuth } from "@ff/auth";
import { membersCollection, userDoc } from "@ff/firestore";

import { DEMO_PEOPLE } from "./tasksSource";

/**
 * Actor + assignee-roster plumbing shared by the compose sheet
 * (TasksApp) and the 3D pin (TaskPin) — the same people fetch, one
 * implementation. `members` stays null until `ensureMembers()` runs
 * (lazy on first compose/pin open, then cached for the session).
 *
 * Demo mode hands this hook a null Firestore — it then returns the
 * static demo roster + demo admin actor, so the assignee picker and
 * "composed by" stamps still work login-free.
 */

export interface TaskPerson {
  uid: string;
  name: string;
}

export function useTaskPeople(
  db: Firestore | null,
  projectId: string | undefined
): { actor: TaskPerson; members: TaskPerson[] | null; ensureMembers: () => Promise<void> } {
  const { user } = useAuth();
  const [profileName, setProfileName] = useState<string | null>(null);
  const [members, setMembers] = useState<TaskPerson[] | null>(null);

  useEffect(() => {
    if (!db || !user) return;
    void getDoc(userDoc(db, user.uid)).then((s) => setProfileName(s.data()?.displayName ?? null));
  }, [db, user]);

  async function ensureMembers(): Promise<void> {
    if (members || !db || !projectId) return;
    const snap = await getDocs(
      query(membersCollection(db, projectId), where("status", "==", "active"))
    );
    const uids = snap.docs.map((d) => d.id);
    const users = await Promise.all(
      uids.map(async (uid) => {
        const s = await getDoc(userDoc(db, uid));
        return { uid, name: s.data()?.displayName ?? uid };
      })
    );
    setMembers(users);
  }

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