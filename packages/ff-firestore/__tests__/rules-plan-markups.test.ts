// @vitest-environment node
/**
 * projects/{pid}/planMarkups/{id}: member-authored vector markups.
 * Read = any active member; create = any active member as `createdBy`;
 * update / tombstone = the author or an admin; identity, plan reference and
 * authorship are immutable; hard delete is denied for everyone.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  setLogLevel,
  type Firestore,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlanMarkupSchema, SYNCED_COLLECTIONS } from "../src";

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

const PID = "p1";
const PATH = `projects/${PID}/planMarkups/m1`;

async function seedDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data as never);
  });
}
async function seedMembership(uid: string, pid: string, role: string, status = "active") {
  await seedDoc(`projects/${pid}/members/${uid}`, {
    uid, role, status, joinedAt: Timestamp.fromMillis(1), invitedBy: "bootstrap",
  });
}
const db = (uid: string): Firestore => testEnv.authenticatedContext(uid).firestore();
const memberDb = async (uid: string, pid = PID, role = "member") => {
  await seedMembership(uid, pid, role);
  return db(uid);
};
const removedDb = async () => {
  await seedMembership("gone", PID, "member", "removed");
  return db("gone");
};
const strangerDb = () => db("stranger");
const anonDb = () => testEnv.unauthenticatedContext().firestore();

const fields = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  projectId: PID,
  pdfFileId: "pf1",
  pdfVersionId: "pv1",
  page: 1,
  kind: "arrow",
  color: "#d94141",
  strokeWidth: 0.003,
  shape: JSON.stringify({ pts: [[0.1, 0.1], [0.4, 0.3]] }),
  bbox: [0.1, 0.1, 0.4, 0.3],
  taskId: null,
  createdBy: "alice",
  createdAt: 1000,
  ...over,
});
const stamp = (uid: string, over: Record<string, unknown> = {}) => ({
  updatedAt: serverTimestamp(),
  updatedBy: uid,
  deletedAt: null,
  schema: 1,
  ...over,
});
const stored = (over: Record<string, unknown> = {}) => ({
  ...fields(),
  updatedAt: Timestamp.fromMillis(1000),
  updatedBy: "alice",
  deletedAt: null,
  schema: 1,
  ...over,
});
const write = (d: Firestore, uid: string, f: Record<string, unknown> = {}, s: Record<string, unknown> = {}) =>
  setDoc(doc(d, PATH), { ...fields(f), ...stamp(uid, s) } as never);

describe("planMarkups contract", () => {
  it("is a synced collection and the fixture satisfies the zod schema", () => {
    expect(SYNCED_COLLECTIONS).toContain("planMarkups");
    expect(PlanMarkupSchema.safeParse(stored()).success).toBe(true);
    expect(PlanMarkupSchema.safeParse({ ...stored(), schema: 2 }).success).toBe(false);
    expect(PlanMarkupSchema.safeParse(stored({ kind: "lasso" })).success).toBe(false);
    expect(PlanMarkupSchema.safeParse(stored({ bbox: [0, 0, 1] })).success).toBe(false);
  });
});

describe("planMarkups read", () => {
  it("any active member (author, other member, admin) reads, tombstones included", async () => {
    await seedDoc(PATH, stored({ deletedAt: Timestamp.fromMillis(5) }));
    await assertSucceeds(getDoc(doc(await memberDb("alice"), PATH)));
    await assertSucceeds(getDoc(doc(await memberDb("bob"), PATH)));
    await assertSucceeds(getDoc(doc(await memberDb("root", PID, "admin"), PATH)));
  });
  it("non-member, removed member, other-project admin and anonymous cannot read", async () => {
    await seedDoc(PATH, stored());
    await assertFails(getDoc(doc(strangerDb(), PATH)));
    await assertFails(getDoc(doc(await removedDb(), PATH)));
    await assertFails(getDoc(doc(await memberDb("other", "p2", "admin"), PATH)));
    await assertFails(getDoc(doc(anonDb(), PATH)));
  });
});

describe("planMarkups create", () => {
  it("a plain member can create their own markup", async () => {
    await assertSucceeds(write(await memberDb("alice"), "alice"));
  });
  it("an admin can create one as themselves", async () => {
    await assertSucceeds(write(await memberDb("root", PID, "admin"), "root", { createdBy: "root" }));
  });
  it("cannot create as somebody else (createdBy must be the caller), not even an admin", async () => {
    await assertFails(write(await memberDb("bob"), "bob", { createdBy: "alice" }));
    await assertFails(write(await memberDb("root", PID, "admin"), "root", { createdBy: "alice" }));
  });
  it("non-member, removed member, other-project admin and anonymous cannot create", async () => {
    await assertFails(write(strangerDb(), "stranger", { createdBy: "stranger" }));
    await assertFails(write(await removedDb(), "gone", { createdBy: "gone" }));
    await assertFails(write(await memberDb("other", "p2", "admin"), "other", { createdBy: "other" }));
    await assertFails(setDoc(doc(anonDb(), PATH), { ...fields(), ...stamp("x") } as never));
  });
  it("rejects extra or missing keys and a bad stamp", async () => {
    const a = await memberDb("alice");
    await assertFails(write(a, "alice", { rogue: true }));
    const { shape: _s, ...noShape } = fields();
    await assertFails(setDoc(doc(a, PATH), { ...noShape, ...stamp("alice") } as never));
    await assertFails(setDoc(doc(a, PATH), fields() as never));
    await assertFails(write(a, "alice", {}, { updatedAt: Timestamp.fromMillis(Date.now()) }));
    await assertFails(write(a, "alice", {}, { updatedBy: "bob" }));
    await assertFails(write(a, "alice", {}, { schema: 2 }));
    await assertFails(write(a, "alice", {}, { deletedAt: serverTimestamp() })); // tombstone on create
    await assertFails(write(a, "alice", { id: "other" }));
  });
  it("rejects bad field values", async () => {
    const a = await memberDb("alice");
    await assertFails(write(a, "alice", { projectId: "p2" }));
    await assertFails(write(a, "alice", { kind: "lasso" }));
    await assertFails(write(a, "alice", { color: "red" }));
    await assertFails(write(a, "alice", { strokeWidth: 0 }));
    await assertFails(write(a, "alice", { strokeWidth: 0.5 }));
    await assertFails(write(a, "alice", { page: 0 }));
    await assertFails(write(a, "alice", { page: 1.5 }));
    await assertFails(write(a, "alice", { bbox: [0, 0, 1] }));
    await assertFails(write(a, "alice", { shape: 7 }));
    await assertFails(write(a, "alice", { shape: "x".repeat(100_001) }));
    await assertFails(write(a, "alice", { taskId: "" }));
  });
  it("accepts a linked task id and every kind", async () => {
    const a = await memberDb("alice");
    await assertSucceeds(write(a, "alice", { taskId: "t1" }));
    for (const kind of ["pen", "highlight", "arrow", "rect", "ellipse", "cloud", "text"]) {
      await assertSucceeds(write(a, "alice", { kind }));
    }
  });
});

describe("planMarkups update and tombstone", () => {
  beforeEach(async () => {
    await seedDoc(PATH, stored());
  });
  it("the author can move (update) and tombstone their markup", async () => {
    const a = await memberDb("alice");
    await assertSucceeds(write(a, "alice", { bbox: [0.2, 0.2, 0.5, 0.4] }));
    await assertSucceeds(write(a, "alice", {}, { deletedAt: serverTimestamp() }));
  });
  it("an admin can edit and tombstone another member's markup, authorship preserved", async () => {
    const adm = await memberDb("root", PID, "admin");
    await assertSucceeds(write(adm, "root", { color: "#2f7d32" }));
    await assertSucceeds(write(adm, "root", {}, { deletedAt: serverTimestamp() }));
  });
  it("another plain member cannot edit or tombstone it", async () => {
    const b = await memberDb("bob");
    await assertFails(write(b, "bob", { color: "#2f7d32" }));
    await assertFails(write(b, "bob", {}, { deletedAt: serverTimestamp() }));
    await assertFails(write(b, "bob", { createdBy: "bob" })); // cannot steal authorship
  });
  it("non-member, removed member and anonymous cannot update", async () => {
    await assertFails(write(strangerDb(), "stranger", {}, { deletedAt: serverTimestamp() }));
    await assertFails(write(await removedDb(), "gone", {}, { deletedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(anonDb(), PATH), { ...fields(), ...stamp("x") } as never));
  });
  it("identity, plan reference, page and authorship are immutable (even for the author)", async () => {
    const a = await memberDb("alice");
    await assertFails(write(a, "alice", { pdfFileId: "pf2" }));
    await assertFails(write(a, "alice", { pdfVersionId: "pv2" }));
    await assertFails(write(a, "alice", { page: 2 }));
    await assertFails(write(a, "alice", { createdAt: 5 }));
    await assertFails(write(a, "alice", { projectId: "p2" }));
  });
  it("a tombstone must use request.time", async () => {
    await assertFails(write(await memberDb("alice"), "alice", {}, { deletedAt: Timestamp.fromMillis(5) }));
  });
  it("the author can bring back their own tombstoned markup (undo of a delete)", async () => {
    await seedDoc(PATH, stored({ deletedAt: Timestamp.fromMillis(5) }));
    await assertSucceeds(write(await memberDb("alice"), "alice"));
  });
});

describe("planMarkups delete", () => {
  it("hard delete is denied for everyone", async () => {
    await seedDoc(PATH, stored());
    await assertFails(deleteDoc(doc(await memberDb("alice"), PATH)));
    await assertFails(deleteDoc(doc(await memberDb("root", PID, "admin"), PATH)));
    await assertFails(deleteDoc(doc(anonDb(), PATH)));
  });
});
