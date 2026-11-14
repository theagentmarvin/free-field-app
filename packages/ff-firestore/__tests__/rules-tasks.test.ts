// @vitest-environment node
/**
 * Security rules tests for the tasks matrix (task-module plan §3,
 * task-39 deliverable 3 — D7 two-role matrix amendment).
 *
 * Proves, for projects/{pid}/tasks/**:
 *   - read = member; WRITE = member (the amendment — first
 *     member-writable collection; everything else in the v4 matrix
 *     keeps member read-only and is covered by rules.test.ts)
 *   - non-member / unauth → DENY everywhere
 *   - status changes must follow the legal pair table
 *   - num / createdBy* are immutable; no client delete
 *   - entries are append-only, docId == clientGuid, author == caller
 *   - taskCounters increment by exactly one per transaction
 *   - wave 63 shape validation: keys().hasOnly on task / entry / counter,
 *     entryCount == 1 on create (the create entry rides the same write),
 *     getAfter coupling task↔counter and entry↔task, and the REAL
 *     commitTaskAction transaction from @ff/tasks passes end to end
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
  updateDoc,
  deleteDoc,
  setLogLevel,
  writeBatch,
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

function authedDb(uid: string, claims: Record<string, unknown> = {}): Firestore {
  return testEnv.authenticatedContext(uid, claims).firestore();
}

// Phase 1b: access comes from the member doc, not from claims.
const memberDb = async (uid = "m1", pid = "p1") => {
  await seedDoc(`projects/${pid}/members/${uid}`, {
    uid, role: "member", status: "active", joinedAt: 1, invitedBy: "bootstrap",
  });
  return authedDb(uid);
};
const adminDb = async (uid = "a1", pid = "p1") => {
  await seedDoc(`projects/${pid}/members/${uid}`, {
    uid, role: "admin", status: "active", joinedAt: 1, invitedBy: "bootstrap",
  });
  return authedDb(uid);
};
const unauthDb = () => testEnv.unauthenticatedContext().firestore();

async function seedDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data as never);
  });
}

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  num: 1,
  title: "Crack in slab",
  description: "",
  type: "task",
  status: 10,
  createdBy: "Ana",
  createdByUid: "m1",
  createdAt: 1,
  updatedBy: "Ana",
  updatedAt: 1,
  assigneeUid: null,
  assigneeName: null,
  deadline: null,
  buildingId: null,
  location: null,
  photos: [],
  lastAction: "create",
  entryCount: 1,
  ...over,
});

const TASK = "projects/p1/tasks/t1";
const COUNTER = "projects/p1/taskCounters/tasks";

const entry = (guid: string, over: Record<string, unknown> = {}) => ({
  id: guid,
  action: "comment",
  text: "",
  by: "Ana",
  byUid: "m1",
  at: 2,
  statusFrom: 10,
  statusTo: 10,
  photos: [],
  clientGuid: guid,
  ...over,
});

/**
 * The create transaction exactly as repository.ts writes it: counter set
 * to `num`, full task doc, and the 'create' entry — one atomic write.
 */
async function createTaskWrite(
  db: Firestore,
  taskId: string,
  over: Record<string, unknown> = {},
  opts: { counter?: number | null; entry?: Record<string, unknown> | null } = {}
): Promise<void> {
  const t = task({ id: taskId, ...over });
  const b = writeBatch(db);
  const counterNext = opts.counter === undefined ? (t.num as number) : opts.counter;
  if (counterNext !== null) b.set(doc(db, COUNTER), { next: counterNext });
  b.set(doc(db, `projects/p1/tasks/${taskId}`), t);
  if (opts.entry !== null) {
    const guid = `create-${taskId}`;
    b.set(
      doc(db, `projects/p1/tasks/${taskId}/entries/${guid}`),
      entry(guid, {
        action: "create",
        byUid: t.createdByUid,
        statusFrom: null,
        statusTo: t.status,
        ...(opts.entry ?? {}),
      })
    );
  }
  await b.commit();
}

/** An update action exactly as repository.ts writes it: entry + task bump. */
async function actionWrite(
  db: Firestore,
  taskPath: string,
  guid: string,
  entryOver: Record<string, unknown>,
  taskPatch: Record<string, unknown>
): Promise<void> {
  const b = writeBatch(db);
  b.set(doc(db, `${taskPath}/entries/${guid}`), entry(guid, entryOver));
  b.update(doc(db, taskPath), taskPatch);
  await b.commit();
}

describe("tasks — matrix amendment (D7)", () => {
  it("member of p1 can create a task at inbox or auto-assign-ongoing", async () => {
    await assertSucceeds(createTaskWrite(await memberDb(), "t1"));
    await assertSucceeds(
      createTaskWrite(await memberDb("m2"), "t2", { num: 2, createdByUid: "m2", status: 20 })
    );
  });

  it("member can create + edit a building-scoped task (UI-refresh v1 buildingId)", async () => {
    await assertSucceeds(createTaskWrite(await memberDb(), "t1", { buildingId: "b-1" }));
    // edits ride the action pattern (entryCount bump + lastAction); the
    // buildingId itself is an ordinary member-writable doc field.
    await seedDoc("projects/p1/tasks/t1/entries/ge1", {
      id: "ge1", action: "edit", text: "re-scope", by: "Ana", byUid: "m1", at: 2,
      statusFrom: 10, statusTo: 10, photos: [], clientGuid: "ge1",
    });
    await assertSucceeds(
      updateDoc(doc(await memberDb(), TASK), { buildingId: "b-2", lastAction: "edit", entryCount: 2, updatedAt: 2 })
    );
    // null stays legal (legacy / cross-building)
    await seedDoc("projects/p1/tasks/t1/entries/ge2", {
      id: "ge2", action: "edit", text: "cross-building", by: "Ana", byUid: "m1", at: 3,
      statusFrom: 10, statusTo: 10, photos: [], clientGuid: "ge2",
    });
    await assertSucceeds(
      updateDoc(doc(await memberDb(), TASK), { buildingId: null, lastAction: "edit", entryCount: 3, updatedAt: 3 })
    );
  });

  it("outsider, wrong-project member and unauth are denied", async () => {
    await seedDoc(TASK, task());
    await assertFails(createTaskWrite(await memberDb("x1", "p2"), "x", { num: 2, createdByUid: "x1" }));
    await assertFails(createTaskWrite(unauthDb(), "x", { num: 2, createdByUid: "anon" }));
    await assertFails(updateDoc(doc(await memberDb("x2", "p2"), TASK), { status: 20, entryCount: 2 }));
    await assertFails(getDoc(doc(unauthDb(), TASK)));
  });

  it("cannot create a task for another author, at a bogus status, or with num 0", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t9", { createdByUid: "someone-else" }));
    await assertFails(createTaskWrite(await memberDb(), "t9", { status: 65 }));
    await assertFails(createTaskWrite(await memberDb(), "t9", { num: 0 }));
  });

  it("non-member can read nothing of the task surface", async () => {
    await seedDoc(TASK, task());
    await seedDoc("projects/p1/tasks/t1/entries/g1", { id: "g1", clientGuid: "g1", byUid: "m1" });
    await assertFails(getDoc(doc(await memberDb("o1", "p2"), TASK)));
    await assertFails(getDoc(doc(await memberDb("o1", "p2"), "projects/p1/tasks/t1/entries/g1")));
  });

  it("legal transition: inbox→ongoing with entryCount bump", async () => {
    await seedDoc(TASK, task({ status: 10 }));
    await assertSucceeds(
      updateDoc(doc(await memberDb("m9"), TASK), {
        status: 20, lastAction: "assign", entryCount: 2, updatedBy: "Sam", updatedAt: 2, assigneeUid: "m9", assigneeName: "Sam",
      })
    );
  });

  it("rework loop: awaiting→ongoing (reject) and followup→awaiting (complete)", async () => {
    await seedDoc(TASK, task({ status: 40, entryCount: 3 }));
    await assertSucceeds(updateDoc(doc(await memberDb(), TASK), { status: 20, lastAction: "reject", entryCount: 4, updatedAt: 2 }));
    await seedDoc("projects/p1/tasks/t2", task({ id: "t2", status: 60, entryCount: 2 }));
    await assertSucceeds(updateDoc(doc(await memberDb(), "projects/p1/tasks/t2"), { status: 40, lastAction: "complete", entryCount: 3, updatedAt: 2 }));
  });

  it("illegal transitions rejected: 10→65, 65→20, 80→any, and terminal self-pairs", async () => {
    await seedDoc(TASK, task({ status: 10 }));
    await assertFails(updateDoc(doc(await memberDb(), TASK), { status: 65, entryCount: 2, lastAction: "approve", updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(await memberDb(), TASK), { status: 80, entryCount: 2, lastAction: "discontinue", updatedAt: 3 })); // 10→80: open ends may be discontinued
    await seedDoc("projects/p1/tasks/t0", task({ id: "t0", status: 30 }));
    await assertFails(updateDoc(doc(await memberDb(), "projects/p1/tasks/t0"), { status: 20, entryCount: 2, lastAction: "assign", updatedAt: 2 })); // reserved 30 has no outgoing pair
    await seedDoc("projects/p1/tasks/t2", task({ id: "t2", status: 65 }));
    await assertFails(updateDoc(doc(await memberDb(), "projects/p1/tasks/t2"), { entryCount: 2, lastAction: "comment", updatedAt: 2 }));
    await seedDoc("projects/p1/tasks/t3", task({ id: "t3", status: 80 }));
    await assertFails(updateDoc(doc(await memberDb(), "projects/p1/tasks/t3"), { status: 20, entryCount: 2, updatedAt: 2 }));
  });

  it("immutable: num, createdBy*, createdAt — and no client delete, even for admin", async () => {
    await seedDoc(TASK, task());
    await assertFails(updateDoc(doc(await memberDb(), TASK), { num: 99, entryCount: 2, updatedAt: 2 }));
    await assertFails(updateDoc(doc(await memberDb(), TASK), { createdByUid: "hax", entryCount: 2, updatedAt: 2 }));
    await assertFails(updateDoc(doc(await memberDb(), TASK), { createdAt: 99, entryCount: 2, updatedAt: 2 }));
    await assertFails(deleteDoc(doc(await memberDb(), TASK)));
    await assertFails(deleteDoc(doc(await adminDb(), TASK)));
  });

  it("update without an entry bump is rejected (the action always appends one entry)", async () => {
    await seedDoc(TASK, task({ status: 20, entryCount: 2 }));
    await assertFails(updateDoc(doc(await memberDb(), TASK), { title: "quiet edit", updatedAt: 2 }));
  });
});

describe("tasks/entries — append-only audit trail", () => {
  const E = (guid: string) => `projects/p1/tasks/t1/entries/${guid}`;

  const bump = { lastAction: "comment", entryCount: 2, updatedAt: 2 };

  it("member create with docId == clientGuid == own uid author is allowed", async () => {
    await seedDoc(TASK, task());
    await assertSucceeds(actionWrite(await memberDb(), TASK, "g1", { text: "ok" }, bump));
  });

  it("mismatched docId/clientGuid or spoofed author is rejected", async () => {
    await seedDoc(TASK, task());
    await assertFails(actionWrite(await memberDb(), TASK, "g1", { clientGuid: "OTHER" }, bump));
    await assertFails(actionWrite(await memberDb(), TASK, "g2", { byUid: "hax" }, bump));
  });

  it("entries can never be updated or deleted — the audit is immutable", async () => {
    await seedDoc(TASK, task());
    await seedDoc(E("g1"), { id: "g1", action: "comment", byUid: "m1", clientGuid: "g1", at: 2, text: "original" });
    await assertFails(updateDoc(doc(await memberDb(), E("g1")), { text: "rewritten" }));
    await assertFails(deleteDoc(doc(await memberDb(), E("g1"))));
    await assertFails(deleteDoc(doc(await adminDb(), E("g1"))));
  });
});

describe("tasks — location thumb (Day-3)", () => {
  const located = task({
    location: {
      storeyName: "L1",
      thumb: { storagePath: "projects/p1/tasks/t1/location-thumb.jpg" },
      bim: {
        elements: [{ modelId: "m1", expressId: 7 }],
        worldPoint: [1, 2, 3],
        cameraPose: { pos: [0, 0, 5], target: [1, 2, 3], fov: 45, isOrtho: false },
      },
      pdf: null,
    },
  });

  it("member can create and read a task carrying location.thumb.storagePath", async () => {
    await assertSucceeds(createTaskWrite(await memberDb(), "t1", located));
    const snap = await getDoc(doc(await memberDb(), TASK));
    expect(snap.data()?.location?.thumb?.storagePath).toBe("projects/p1/tasks/t1/location-thumb.jpg");
  });

  it("non-member cannot read the location thumb (same read boundary as the task)", async () => {
    await seedDoc(TASK, located);
    await assertFails(getDoc(doc(await memberDb("o1", "p2"), TASK)));
  });
});

describe("taskCounters — display-number atomicity", () => {
  const C = COUNTER;

  it("member may seed next=1 and increment by exactly one", async () => {
    await assertSucceeds(setDoc(doc(await memberDb(), C), { next: 1 }));
    await seedDoc(C, { next: 1 });
    await assertSucceeds(updateDoc(doc(await memberDb(), C), { next: 2 }));
  });

  it("seeding at anything but 1, skipping, or outsider writes are rejected", async () => {
    await assertFails(setDoc(doc(await memberDb(), C), { next: 7 }));
    await seedDoc(C, { next: 1 });
    await assertFails(updateDoc(doc(await memberDb(), C), { next: 4 }));
    await assertFails(setDoc(doc(await memberDb("x", "p2"), "projects/p1/taskCounters/tasks"), { next: 1 }));
  });

  it("the doc id is 'tasks' — no extra counter docs for members", async () => {
    await assertFails(setDoc(doc(await memberDb(), "projects/p1/taskCounters/other"), { next: 1 }));
  });

  it("nobody deletes counters client-side", async () => {
    await seedDoc(C, { next: 3 });
    await assertFails(deleteDoc(doc(await adminDb(), C)));
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave 63 — shape validation + cross-doc coupling
// ────────────────────────────────────────────────────────────────────
describe("tasks — shape validation (wave 63)", () => {
  it("create rejects unknown task fields (keys().hasOnly)", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t1", { isAdmin: true }));
    await assertFails(createTaskWrite(await memberDb(), "t1", { role: "admin" }));
  });

  it("create pins entryCount to 1 — the create entry rides the same write", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t1", { entryCount: 0 }));
    await assertFails(createTaskWrite(await memberDb(), "t1", { entryCount: 5 }));
  });

  it("create rejects a doc whose id field disagrees with its path", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t1", { id: "other" }));
  });

  it("update rejects unknown task fields", async () => {
    await seedDoc(TASK, task());
    await assertFails(
      updateDoc(doc(await memberDb(), TASK), { lastAction: "edit", entryCount: 2, updatedAt: 2, injected: "x" })
    );
  });

  it("entry create rejects unknown fields", async () => {
    await seedDoc(TASK, task());
    await assertFails(
      actionWrite(await memberDb(), TASK, "g1", { extra: 1 }, { lastAction: "comment", entryCount: 2, updatedAt: 2 })
    );
  });

  it("counter writes reject extra fields", async () => {
    await assertFails(setDoc(doc(await memberDb(), COUNTER), { next: 1, other: 1 }));
    await seedDoc(COUNTER, { next: 1 });
    await assertFails(updateDoc(doc(await memberDb(), COUNTER), { next: 2, other: 1 }));
  });
});

describe("tasks — getAfter coupling (wave 63)", () => {
  it("task create without the counter bump in the same write is denied", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t1", {}, { counter: null }));
    // a bare task setDoc (no counter, no entry) is denied too
    await assertFails(setDoc(doc(await memberDb(), TASK), task()));
  });

  it("task create must claim exactly the number the counter moves to", async () => {
    await seedDoc(COUNTER, { next: 3 });
    // counter goes 3→4 but the task claims 7
    await assertFails(createTaskWrite(await memberDb(), "t1", { num: 7 }, { counter: 4 }));
    // reusing an already-allocated number (no bump) is denied
    await assertFails(createTaskWrite(await memberDb(), "t1", { num: 3 }, { counter: null }));
    // the legal next allocation passes
    await assertSucceeds(createTaskWrite(await memberDb(), "t1", { num: 4 }));
  });

  it("first task in a project must be num 1 (counter absent → created at 1)", async () => {
    await assertFails(createTaskWrite(await memberDb(), "t1", { num: 2 }, { counter: 2 }));
    await assertSucceeds(createTaskWrite(await memberDb(), "t1", { num: 1 }));
  });

  it("entry create without a task write in the same transaction is denied", async () => {
    await seedDoc(TASK, task({ status: 10, entryCount: 1 }));
    await assertFails(
      setDoc(doc(await memberDb(), `${TASK}/entries/g1`), entry("g1"))
    );
  });

  it("create entry is denied when the task create is missing or already existed", async () => {
    // create entry on its own (no task in the same write)
    await assertFails(
      setDoc(
        doc(await memberDb(), `${TASK}/entries/c1`),
        entry("c1", { action: "create", statusFrom: null, statusTo: 10 })
      )
    );
    // a second 'create' entry on an existing task
    await seedDoc(TASK, task());
    await assertFails(
      actionWrite(
        await memberDb(), TASK, "c2",
        { action: "create", statusFrom: null, statusTo: 10 },
        { lastAction: "edit", entryCount: 2, updatedAt: 2 }
      )
    );
  });

  it("entry must record the real status edge of the task write", async () => {
    await seedDoc(TASK, task({ status: 10, entryCount: 1 }));
    // claims 20→40 while the task actually goes 10→20
    await assertFails(
      actionWrite(
        await memberDb(), TASK, "g1",
        { action: "complete", statusFrom: 20, statusTo: 40 },
        { status: 20, lastAction: "assign", entryCount: 2, updatedAt: 2 }
      )
    );
    // matching edge passes
    await assertSucceeds(
      actionWrite(
        await memberDb(), TASK, "g2",
        { action: "assign", statusFrom: 10, statusTo: 20 },
        { status: 20, lastAction: "assign", entryCount: 2, updatedAt: 2 }
      )
    );
  });
});

describe("tasks — real repository transaction (wave 63 parity)", () => {
  it("commitTaskAction create + assign + comment pass the rules end to end", async () => {
    const { commitTaskAction } = await import("../../ff-tasks/src/repository");
    const { buildActionPayload } = await import("../../ff-tasks/src/action");
    const db = await memberDb("m1");
    const actor = { uid: "m1", name: "Ana" };
    const createDoc = {
      description: "",
      type: "task",
      deadline: null,
      buildingId: null,
      assigneeUid: null,
      assigneeName: null,
      location: null,
      photos: [],
    };
    for (const [taskId, at] of [["rt1", 10], ["rt2", 20]] as const) {
      const create = buildActionPayload({
        verb: "create", projectId: "p1", taskId, statusFrom: null, actor,
        title: "Real path", at, createDoc,
      });
      await assertSucceeds(commitTaskAction(db, create));
      // replaying the same payload is an idempotent no-op
      await assertSucceeds(commitTaskAction(db, create));
      const assign = buildActionPayload({
        verb: "assign", projectId: "p1", taskId, statusFrom: create.statusTo, actor,
        title: "Real path", at: at + 1, patch: { assigneeUid: "m1", assigneeName: "Ana" },
      });
      await assertSucceeds(commitTaskAction(db, assign));
      const comment = buildActionPayload({
        verb: "comment", projectId: "p1", taskId, statusFrom: assign.statusTo, actor,
        title: "Real path", at: at + 2, text: "on it",
      });
      await assertSucceeds(commitTaskAction(db, comment));
    }
    const t1 = await getDoc(doc(db, "projects/p1/tasks/rt1"));
    const t2 = await getDoc(doc(db, "projects/p1/tasks/rt2"));
    expect(t1.data()?.num).toBe(1);
    expect(t2.data()?.num).toBe(2);
    expect(t2.data()?.entryCount).toBe(3);
    const counter = await getDoc(doc(db, COUNTER));
    expect(counter.data()?.next).toBe(2);
  });
});
