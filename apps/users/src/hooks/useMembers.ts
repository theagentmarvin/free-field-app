import { useEffect, useState } from 'react';
import { getDoc, getFirestore, onSnapshot } from 'firebase/firestore';
import { useAuthContext, useCurrentProject } from '@ff/auth';
import { membersCollection, userDoc } from '@ff/firestore';

export interface MemberRow {
  uid: string;
  email: string;
  role: 'admin' | 'member';
  status: string;
}

/**
 * Live list of a project's members, joined with each member's email from
 * the `/users/{uid}` profile. Returns `undefined` while loading (the
 * project is still resolving, or the first snapshot + email join hasn't
 * finished) so the caller renders a loading state — never a premature
 * "No members yet".
 *
 * Each snapshot's async email join carries a staleness token: a slower
 * join from an older snapshot (or a previous project) can never
 * overwrite a newer result.
 *
 * v4 two-role model: role is `admin` | `member`. The member row order is
 * stable (email ascending) so the table doesn't reshuffle on each tick.
 */
export function useMembers(): MemberRow[] | undefined {
  const project = useCurrentProject();
  const projectId = project?.id;
  const projectResolved = project !== undefined;
  const { app } = useAuthContext();
  const [rows, setRows] = useState<MemberRow[] | undefined>(undefined);

  useEffect(() => {
    // Back to "loading" whenever the project changes.
    setRows(undefined);
    if (!projectResolved) return;
    if (!projectId) {
      setRows([]);
      return;
    }

    let cancelled = false;
    let latest = 0;
    const db = getFirestore(app);
    const unsubscribe = onSnapshot(
      membersCollection(db, projectId),
      async (snapshot) => {
        const token = ++latest;
        const emails = new Map<string, string>();
        await Promise.all(
          snapshot.docs.map(async (d) => {
            try {
              const userSnap = await getDoc(userDoc(db, d.id));
              const email = userSnap.exists() ? userSnap.data()?.email : undefined;
              emails.set(d.id, email ?? d.id);
            } catch {
              emails.set(d.id, d.id);
            }
          })
        );
        if (cancelled || token !== latest) return;

        const next: MemberRow[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            uid: d.id,
            email: emails.get(d.id) ?? d.id,
            role: data.role,
            status: data.status,
          };
        });
        next.sort((a, b) => a.email.localeCompare(b.email));
        setRows(next);
      },
      (err) => {
        if (cancelled) return;
        console.error('useMembers: listener error', err);
        setRows([]);
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, projectResolved, app]);

  return rows;
}
