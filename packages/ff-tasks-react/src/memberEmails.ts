import { getDoc, getDocs, query, where, type Firestore } from "firebase/firestore";

import { membersCollection, userDoc } from "@ff/firestore";

import type { BcfPerson } from "./bcfExport";

/**
 * One-shot roster with e-mails for the BCF export (BCF authors are
 * e-mail addresses). `useTaskPeople` only keeps display names, so this
 * re-reads the active members' profile docs once, at export time.
 * Failures degrade to an empty list (the directory then falls back to
 * display names).
 */
export async function loadMemberEmails(db: Firestore, projectId: string): Promise<BcfPerson[]> {
  try {
    const snap = await getDocs(query(membersCollection(db, projectId), where("status", "==", "active")));
    return await Promise.all(
      snap.docs.map(async (d): Promise<BcfPerson> => {
        try {
          const u = (await getDoc(userDoc(db, d.id))).data();
          return { uid: d.id, name: u?.displayName ?? null, email: u?.email ?? null };
        } catch {
          return { uid: d.id };
        }
      }),
    );
  } catch {
    return [];
  }
}
