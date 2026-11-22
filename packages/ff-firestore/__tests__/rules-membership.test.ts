// @vitest-environment node
/**
 * Phase 1b membership rules (docs/SPEC-PHASE-1.md §3, §8).
 *
 * Access is decided by the member doc /projects/{pid}/members/{uid}
 * (status 'active'), NOT by token claims. Every context here is signed in
 * WITHOUT claims, except where a test deliberately forges one.
 *
 *   member / non-member / removed / pending / admin, cross-project,
 *   immediate revocation and demotion, forged claims, and the
 *   collection-group membership discovery rule.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  setLogLevel,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, "..", "firestore.rules");

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  setLogLevel("error");
  testEnv = await initializeTestEnvironment({
    projectId: "demo-freefield",
    firestore: { rules: readFileSync(RULES_PATH, "utf8") },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
beforeEach(async () => {
  await testEnv.clearFirestore();
});

const asUser = (uid: string, claims: Record<string, unknown> = {}): Firestore =>
  testEnv.authenticatedContext(uid, claims).firestore();

async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data as never);
  });
}

async function addMember(
  pid: string,
  uid: string,
  role: "admin" | "member",
  status = "active",
  withUid = true
): Promise<void> {
  await seed(`projects/${pid}/members/${uid}`, {
    ...(withUid ? { uid } : {}),
    role,
    status,
    joinedAt: 1,
    invitedBy: "bootstrap",
  });
}

beforeEach(async () => {
  await seed("projects/p1", { name: "One", createdBy: "boss", createdAt: 1 });
  await seed("projects/p2", { name: "Two", createdBy: "boss", createdAt: 1 });
  await seed("projects/p1/buildings/b1", { name: "B1" });
  await seed("projects/p2/buildings/b2", { name: "B2" });
});

describe("membership-doc authorization (no claims)", () => {
  it("an active member reads their project and its content; a non-member cannot", async () => {
    await addMember("p1", "alice", "member");
    await assertSucceeds(getDoc(doc(asUser("alice"), "projects/p1")));
    await assertSucceeds(getDoc(doc(asUser("alice"), "projects/p1/buildings/b1")));
    await assertFails(getDoc(doc(asUser("zed"), "projects/p1")));
    await assertFails(getDoc(doc(asUser("zed"), "projects/p1/buildings/b1")));
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "projects/p1")));
  });

  it("a removed or pending-acceptance member doc grants nothing", async () => {
    await addMember("p1", "gone", "admin", "removed");
    await addMember("p1", "wait", "member", "pending-acceptance");
    await assertFails(getDoc(doc(asUser("gone"), "projects/p1")));
    await assertFails(getDoc(doc(asUser("wait"), "projects/p1")));
    await assertFails(updateDoc(doc(asUser("gone"), "projects/p1"), { name: "x" }));
  });

  it("cross-project: membership of p1 gives nothing in p2 (read or write)", async () => {
    await addMember("p1", "alice", "admin");
    await assertFails(getDoc(doc(asUser("alice"), "projects/p2")));
    await assertFails(getDoc(doc(asUser("alice"), "projects/p2/buildings/b2")));
    await assertFails(updateDoc(doc(asUser("alice"), "projects/p2"), { name: "x" }));
    await assertFails(getDoc(doc(asUser("alice"), "projects/p2/members/alice")));
  });

  it("a user in TWO projects reads both with one identity (no claim switching)", async () => {
    await addMember("p1", "alice", "member");
    await addMember("p2", "alice", "admin");
    await assertSucceeds(getDoc(doc(asUser("alice"), "projects/p1/buildings/b1")));
    await assertSucceeds(getDoc(doc(asUser("alice"), "projects/p2/buildings/b2")));
    // role is per project: admin in p2 only
    await assertFails(updateDoc(doc(asUser("alice"), "projects/p1"), { name: "x" }));
    await assertSucceeds(updateDoc(doc(asUser("alice"), "projects/p2"), { name: "x" }));
  });

  it("admin writes content; member cannot; members/invitations/auditLog stay functions-only", async () => {
    await addMember("p1", "boss", "admin");
    await addMember("p1", "alice", "member");
    await assertSucceeds(updateDoc(doc(asUser("boss"), "projects/p1"), { name: "x" }));
    await assertFails(updateDoc(doc(asUser("alice"), "projects/p1"), { name: "y" }));
    await assertFails(setDoc(doc(asUser("boss"), "projects/p1/members/mallory"), { uid: "mallory", role: "admin", status: "active" }));
    await assertFails(deleteDoc(doc(asUser("boss"), "projects/p1/members/alice")));
    await assertFails(setDoc(doc(asUser("boss"), "projects/p1/invitations/i1"), { email: "a@b.c" }));
    await assertSucceeds(getDoc(doc(asUser("boss"), "projects/p1/members/alice")));
  });

  it("claims alone grant nothing: a forged admin claim without a member doc is denied", async () => {
    const forged = { currentProject: { id: "p1", role: "admin" } };
    await assertFails(getDoc(doc(asUser("mallory", forged), "projects/p1")));
    await assertFails(updateDoc(doc(asUser("mallory", forged), "projects/p1"), { name: "x" }));
  });

  it("a stale admin claim does not outlive the member doc (immediate demotion / removal)", async () => {
    const stale = { currentProject: { id: "p1", role: "admin" } };
    await addMember("p1", "boss", "admin");
    await assertSucceeds(updateDoc(doc(asUser("boss", stale), "projects/p1"), { name: "a" }));

    // Demoted server-side; the token still says admin.
    await addMember("p1", "boss", "member");
    await assertFails(updateDoc(doc(asUser("boss", stale), "projects/p1"), { name: "b" }));
    await assertSucceeds(getDoc(doc(asUser("boss", stale), "projects/p1/buildings/b1")));

    // Removed (doc deleted by the removeMember function): even reads stop.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "projects/p1/members/boss"));
    });
    await assertFails(getDoc(doc(asUser("boss", stale), "projects/p1/buildings/b1")));
  });
});

describe("collection-group membership discovery", () => {
  it("a user lists ALL their own active memberships across projects", async () => {
    await addMember("p1", "alice", "member");
    await addMember("p2", "alice", "admin");
    await addMember("p1", "bob", "member");
    const snap = await assertSucceeds(
      getDocs(
        query(
          collectionGroup(asUser("alice"), "members"),
          where("uid", "==", "alice"),
          where("status", "==", "active")
        )
      )
    );
    expect(snap.docs.map((d) => d.ref.path).sort()).toEqual([
      "projects/p1/members/alice",
      "projects/p2/members/alice",
    ]);
  });

  it("another user's memberships cannot be queried, nor can the whole group", async () => {
    await addMember("p1", "alice", "member");
    await addMember("p1", "bob", "member");
    const db = asUser("alice");
    await assertFails(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "bob"))));
    await assertFails(getDocs(collectionGroup(db, "members")));
    await assertFails(
      getDocs(query(collectionGroup(testEnv.unauthenticatedContext().firestore(), "members"), where("uid", "==", "alice")))
    );
  });

  it("a doc without a `uid` field (pre-backfill) is not discoverable", async () => {
    await addMember("p1", "alice", "member", "active", false);
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(asUser("alice"), "members"), where("uid", "==", "alice")))
    );
    expect(snap.empty).toBe(true); // the query matches no doc: discovery needs the backfill
    // ...but the project-scoped roster read still works for the member.
    await assertSucceeds(getDocs(collection(asUser("alice"), "projects/p1/members")));
  });

  it("discovery is read-only: the group rule grants no writes", async () => {
    await addMember("p1", "alice", "member");
    await assertFails(updateDoc(doc(asUser("alice"), "projects/p1/members/alice"), { role: "admin" }));
  });
});
