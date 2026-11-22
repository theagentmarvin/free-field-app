// @vitest-environment node
/**
 * Phase 1c synced-collection rules (docs/SPEC-PHASE-1.md §4/§8):
 * projects/{pid}/{buildings,ifcFiles,ifcVersions,storeys,extractedStoreys,
 * pdfFiles,pdfVersions,calibrations,folders,folderAssignments,viewpoints}.
 *
 * Every collection gets allow AND deny cases for member / non-member /
 * removed / admin, bad key sets, wrong stamps, tombstones and hard deletes.
 * Collection-specific invariants (blob paths, immutability, deterministic
 * ids, caps) are pinned at the bottom. The generated doc fixtures are also
 * validated against the zod schemas so rules and schemas cannot drift.
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
  serverTimestamp,
  Timestamp,
  setLogLevel,
  type Firestore,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BuildingSchema,
  IfcFileSchema,
  IfcVersionSchema,
  StoreySchema,
  ExtractedStoreySchema,
  PdfFileSchema,
  PdfVersionSchema,
  CalibrationSchema,
  FolderSchema,
  FolderAssignmentSchema,
  ViewpointSchema,
  calibrationDocId,
  SYNCED_COLLECTIONS,
  ifcStoragePath,
  fragStoragePath,
  pdfStoragePath,
} from "../src";

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
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

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
const adminDb = async (uid = "admin1", pid = PID) => {
  await seedMembership(uid, pid, "admin");
  return db(uid);
};
const memberDb = async (uid = "member1", pid = PID) => {
  await seedMembership(uid, pid, "member");
  return db(uid);
};
const removedAdminDb = async () => {
  await seedMembership("gone", PID, "admin", "removed");
  return db("gone");
};
const strangerDb = () => db("stranger");
const anonDb = () => testEnv.unauthenticatedContext().firestore();

/** The sync stamp a correct client writes. */
const stamp = (uid: string, over: Record<string, unknown> = {}) => ({
  updatedAt: serverTimestamp(),
  updatedBy: uid,
  deletedAt: null,
  schema: 1,
  ...over,
});

interface Case {
  name: string;
  coll: string;
  docId: string;
  schema: { safeParse(v: unknown): { success: boolean } };
  /** Fields without the sync stamp. */
  fields: (pid?: string) => Record<string, unknown>;
}

const PAIR = { pdfX: 0, pdfY: 0, worldX: 1, worldZ: 2 };

const CASES: Case[] = [
  {
    name: "buildings", coll: "buildings", docId: "b1", schema: BuildingSchema,
    fields: (pid = PID) => ({ id: "b1", projectId: pid, name: "Tower A", metadata: {}, createdAt: 1 }),
  },
  {
    name: "ifcFiles", coll: "ifcFiles", docId: "f1", schema: IfcFileSchema,
    fields: () => ({ id: "f1", buildingId: "b1", name: "a.ifc", currentVersionId: "", createdAt: 1 }),
  },
  {
    name: "ifcVersions", coll: "ifcVersions", docId: "v1", schema: IfcVersionSchema,
    fields: (pid = PID) => ({
      id: "v1", ifcFileId: "f1", versionNumber: 1, ifcFileSize: 10, contentHash: "h",
      fragBlobKey: "k", storeyCount: 2, createdAt: 1, isLatest: true,
      storagePath: ifcStoragePath(pid, "v1"), sha256: SHA, sizeBytes: 10,
      contentType: "application/octet-stream",
      fragStoragePath: fragStoragePath(pid, "v1"), fragSha256: SHA2, fragSizeBytes: 5,
    }),
  },
  {
    name: "storeys", coll: "storeys", docId: "s1", schema: StoreySchema,
    fields: () => ({
      id: "s1", buildingId: "b1", ifcVersionId: "v1", sourceIfcFileId: "f1",
      name: "L1", elevation: 0, expressId: 12, height: null, containedElementIds: [1, 2, 3],
    }),
  },
  {
    name: "extractedStoreys", coll: "extractedStoreys", docId: "e1", schema: ExtractedStoreySchema,
    fields: () => ({ id: "e1", buildingId: "b1", storeyId: "s1" }),
  },
  {
    name: "pdfFiles", coll: "pdfFiles", docId: "pf1", schema: PdfFileSchema,
    fields: () => ({ id: "pf1", buildingId: "b1", name: "plan.pdf", createdAt: 1 }),
  },
  {
    name: "pdfVersions", coll: "pdfVersions", docId: "pv1", schema: PdfVersionSchema,
    fields: (pid = PID) => ({
      id: "pv1", pdfFileId: "pf1", versionNumber: 1, name: "plan.pdf", size: 100,
      contentHash: "h", pageCount: 1, width: 595, height: 842, storedAt: 1, blobKey: "k",
      isLatest: true, storagePath: pdfStoragePath(pid, "pv1"), sha256: SHA, sizeBytes: 100,
      contentType: "application/pdf",
    }),
  },
  {
    name: "calibrations", coll: "calibrations", docId: calibrationDocId("pf1", "Level 1/Core"),
    schema: CalibrationSchema,
    fields: (pid = PID) => ({
      id: calibrationDocId("pf1", "Level 1/Core"), projectId: pid, pdfFileId: "pf1",
      storeyName: "Level 1/Core", pointPairs: [PAIR, PAIR],
      transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
      confidence: 1, createdAt: 1,
    }),
  },
  {
    name: "folders", coll: "folders", docId: "fo1", schema: FolderSchema,
    fields: (pid = PID) => ({ id: "fo1", projectId: pid, parentId: null, name: "Arch", color: "blue", createdAt: 1 }),
  },
  {
    name: "folderAssignments", coll: "folderAssignments", docId: "pf1", schema: FolderAssignmentSchema,
    fields: () => ({ id: "pf1", pdfFileId: "pf1", folderId: "fo1", createdAt: 1 }),
  },
  {
    name: "viewpoints", coll: "viewpoints", docId: "vp1", schema: ViewpointSchema,
    fields: (pid = PID) => ({ id: "vp1", projectId: pid, name: "Lobby", createdAt: 1, blob: "{}" }),
  },
];

const pathOf = (c: Case, pid = PID) => `projects/${pid}/${c.coll}/${c.docId}`;
/** A live doc as the server stores it (for seeding reads / updates). */
const stored = (c: Case, pid = PID, over: Record<string, unknown> = {}) => ({
  ...c.fields(pid),
  updatedAt: Timestamp.fromMillis(1000),
  updatedBy: "admin1",
  deletedAt: null,
  schema: 1,
  ...over,
});

describe("contract coverage", () => {
  it("every synced collection has a rules case and a zod schema", () => {
    expect(CASES.map((c) => c.coll).sort()).toEqual([...SYNCED_COLLECTIONS].sort());
  });

  it("the fixtures satisfy the zod schemas (rules and schemas cannot drift)", () => {
    for (const c of CASES) {
      const ok = c.schema.safeParse(stored(c));
      expect(ok.success, `${c.name} fixture`).toBe(true);
      const bad = c.schema.safeParse({ ...stored(c), extra: 1, schema: 2 });
      expect(bad.success, `${c.name} bad fixture`).toBe(false);
    }
  });
});

for (const c of CASES) {
  describe(`/projects/{pid}/${c.coll}/{id}`, () => {
    const write = (d: Firestore, uid: string, over: Record<string, unknown> = {}, fields = c.fields()) =>
      setDoc(doc(d, pathOf(c)), { ...fields, ...stamp(uid), ...over } as never);

    // ── reads ──
    it("active member and admin can read (tombstones included)", async () => {
      await seedDoc(pathOf(c), stored(c, PID, { deletedAt: Timestamp.fromMillis(5) }));
      await assertSucceeds(getDoc(doc(await memberDb(), pathOf(c))));
      await assertSucceeds(getDoc(doc(await adminDb(), pathOf(c))));
    });
    it("non-member, removed member, other-project admin and anonymous cannot read", async () => {
      await seedDoc(pathOf(c), stored(c));
      await assertFails(getDoc(doc(strangerDb(), pathOf(c))));
      await assertFails(getDoc(doc(await removedAdminDb(), pathOf(c))));
      await assertFails(getDoc(doc(await adminDb("other", "p2"), pathOf(c))));
      await assertFails(getDoc(doc(anonDb(), pathOf(c))));
    });

    // ── create ──
    it("admin can create a well-formed doc", async () => {
      await assertSucceeds(write(await adminDb(), "admin1"));
    });
    it("member, non-member, removed admin, other-project admin and anonymous cannot create", async () => {
      await assertFails(write(await memberDb(), "member1"));
      await assertFails(write(strangerDb(), "stranger"));
      await assertFails(write(await removedAdminDb(), "gone"));
      await assertFails(write(await adminDb("other", "p2"), "other"));
      await assertFails(setDoc(doc(anonDb(), pathOf(c)), { ...c.fields(), ...stamp("x") } as never));
    });
    it("rejects an extra key, a missing key, and a missing stamp", async () => {
      const a = await adminDb();
      await assertFails(write(a, "admin1", { rogue: true }));
      const { id: _id, ...noId } = c.fields();
      await assertFails(setDoc(doc(a, pathOf(c)), { ...noId, ...stamp("admin1") } as never));
      await assertFails(setDoc(doc(a, pathOf(c)), c.fields() as never));
    });
    it("rejects a wrong updatedAt (client clock, not request.time)", async () => {
      const a = await adminDb();
      await assertFails(write(a, "admin1", { updatedAt: Timestamp.fromMillis(Date.now()) }));
      await assertFails(write(a, "admin1", { updatedAt: Date.now() }));
      await assertFails(write(a, "admin1", { updatedAt: null }));
    });
    it("rejects a wrong updatedBy, schema, deletedAt and id", async () => {
      const a = await adminDb();
      await assertFails(write(a, "admin1", { updatedBy: "someone-else" }));
      await assertFails(write(a, "admin1", { schema: 2 }));
      await assertFails(write(a, "admin1", { schema: "1" }));
      await assertFails(write(a, "admin1", { deletedAt: Timestamp.fromMillis(5) }));
      await assertFails(write(a, "admin1", { deletedAt: serverTimestamp() })); // tombstone-on-create
      await assertFails(write(a, "admin1", { id: "other-id" }));
    });

    // ── update / tombstone ──
    it("admin can update, and tombstone via update (deletedAt == request.time)", async () => {
      await seedDoc(pathOf(c), stored(c));
      const a = await adminDb();
      await assertSucceeds(write(a, "admin1"));
      await assertSucceeds(write(a, "admin1", { deletedAt: serverTimestamp() }));
    });
    it("member / non-member / removed admin cannot update or tombstone", async () => {
      await seedDoc(pathOf(c), stored(c));
      await assertFails(write(await memberDb(), "member1", { deletedAt: serverTimestamp() }));
      await assertFails(write(strangerDb(), "stranger", { deletedAt: serverTimestamp() }));
      await assertFails(write(await removedAdminDb(), "gone", { deletedAt: serverTimestamp() }));
    });
    it("a tombstone must use request.time, not an arbitrary timestamp", async () => {
      await seedDoc(pathOf(c), stored(c));
      await assertFails(write(await adminDb(), "admin1", { deletedAt: Timestamp.fromMillis(5) }));
    });

    // ── delete ──
    it("hard delete is denied for everyone (admin, member, anonymous)", async () => {
      await seedDoc(pathOf(c), stored(c));
      await assertFails(deleteDoc(doc(await adminDb(), pathOf(c))));
      await assertFails(deleteDoc(doc(await memberDb(), pathOf(c))));
      await assertFails(deleteDoc(doc(anonDb(), pathOf(c))));
    });
  });
}

// ── Collection-specific invariants ───────────────────────────────────
const byName = (n: string) => CASES.find((c) => c.name === n)!;
const put = (d: Firestore, c: Case, over: Record<string, unknown>, uid = "admin1") =>
  setDoc(doc(d, pathOf(c)), { ...c.fields(), ...stamp(uid), ...over } as never);

describe("buildings / folders / calibrations / viewpoints carry projectId == pid", () => {
  it("rejects a projectId from another project", async () => {
    const a = await adminDb();
    for (const n of ["buildings", "folders", "calibrations", "viewpoints"]) {
      await assertFails(put(a, byName(n), { projectId: "p2" }));
    }
  });
  it("projectId is immutable on update", async () => {
    const c = byName("buildings");
    await seedDoc(pathOf(c), stored(c));
    await assertFails(put(await adminDb(), c, { projectId: "p2" }));
  });
});

describe("ifcVersions", () => {
  const c = byName("ifcVersions");
  it("accepts a version with no IFC blob (null group) and no frag yet", async () => {
    await assertSucceeds(
      put(await adminDb(), c, {
        storagePath: null, sha256: null, sizeBytes: null, contentType: null,
        fragStoragePath: null, fragSha256: null, fragSizeBytes: null,
      })
    );
  });
  it("rejects blob paths that do not follow the version-id convention", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { storagePath: "projects/p1/ifc/other.ifc" }));
    await assertFails(put(a, c, { fragStoragePath: "projects/p2/frag/v1.frag" }));
    await assertFails(put(a, c, { fragStoragePath: "projects/p1/frag/v1.ifc" }));
  });
  it("rejects half-filled blob groups, bad sha256, oversize and wrong content type", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { sha256: null }));
    await assertFails(put(a, c, { fragSha256: null }));
    await assertFails(put(a, c, { sha256: "XYZ" }));
    await assertFails(put(a, c, { fragSha256: "A".repeat(64) }));
    await assertFails(put(a, c, { fragSizeBytes: 500 * 1024 * 1024 + 1 }));
    await assertFails(put(a, c, { sizeBytes: 1024 * 1024 * 1024 + 1 }));
    await assertFails(put(a, c, { contentType: "application/pdf" }));
  });
  it("the frag reference can be filled in later, but then it is immutable", async () => {
    const nofrag = { fragStoragePath: null, fragSha256: null, fragSizeBytes: null };
    await seedDoc(pathOf(c), stored(c, PID, nofrag));
    const a = await adminDb();
    await assertSucceeds(put(a, c, {})); // null -> value, once
    await seedDoc(pathOf(c), stored(c));
    await assertFails(put(a, c, { fragSha256: SHA })); // value -> different value
    await assertFails(put(a, c, { sha256: SHA2 }));
    await assertFails(put(a, c, { storagePath: null, sha256: null, sizeBytes: null, contentType: null }));
  });
  it("identity fields and versionNumber are immutable; isLatest can flip", async () => {
    await seedDoc(pathOf(c), stored(c));
    const a = await adminDb();
    await assertFails(put(a, c, { versionNumber: 2 }));
    await assertFails(put(a, c, { ifcFileId: "f2" }));
    await assertSucceeds(put(a, c, { isLatest: false }));
  });
});

describe("pdfVersions", () => {
  const c = byName("pdfVersions");
  it("rejects wrong path, content type, oversize, bad sha; blob fields immutable", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { storagePath: "projects/p1/pdf/zzz.pdf" }));
    await assertFails(put(a, c, { storagePath: null }));
    await assertFails(put(a, c, { contentType: "application/octet-stream" }));
    await assertFails(put(a, c, { sizeBytes: 200 * 1024 * 1024 + 1 }));
    await assertFails(put(a, c, { sha256: "short" }));
    await seedDoc(pathOf(c), stored(c));
    await assertFails(put(a, c, { sha256: SHA2 }));
    await assertFails(put(a, c, { versionNumber: 3 }));
    await assertSucceeds(put(a, c, { isLatest: false }));
  });
});

describe("calibrations (deterministic id)", () => {
  const c = byName("calibrations");
  it("rejects a doc id that is not {pdfFileId}__{storey}", async () => {
    const a = await adminDb();
    const other = `projects/${PID}/calibrations/not-deterministic`;
    await assertFails(
      setDoc(doc(a, other), { ...c.fields(), id: "not-deterministic", ...stamp("admin1") } as never)
    );
    const wrongPdf = `projects/${PID}/calibrations/pfX__L1`;
    await assertFails(
      setDoc(doc(a, wrongPdf), { ...c.fields(), id: "pfX__L1", ...stamp("admin1") } as never)
    );
  });
  it("rejects a malformed transformParams / pointPairs", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { transformParams: { scale: 1 } }));
    await assertFails(put(a, c, { pointPairs: [PAIR] }));
  });
  it("two devices writing the same pair converge on one doc (second write is an update)", async () => {
    const a = await adminDb();
    await assertSucceeds(put(a, c, {}));
    await assertSucceeds(put(a, c, { confidence: 0.9 }));
    await assertFails(put(a, c, { storeyName: "Different" }));
  });
});

describe("folderAssignments (doc id == pdfFileId)", () => {
  const c = byName("folderAssignments");
  it("rejects pdfFileId != doc id; moving = update of folderId", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { pdfFileId: "pfZ" }));
    await assertSucceeds(put(a, c, {}));
    await assertSucceeds(put(a, c, { folderId: "fo2" }));
  });
});

describe("folders", () => {
  const c = byName("folders");
  it("a folder cannot be its own parent; parentId can be a string or null", async () => {
    const a = await adminDb();
    await assertFails(put(a, c, { parentId: "fo1" }));
    await assertSucceeds(put(a, c, { parentId: "fo0" }));
  });
});

describe("viewpoints / storeys / buildings size and type guards", () => {
  it("viewpoint blob over 256 KB is rejected", async () => {
    const c = byName("viewpoints");
    await assertFails(put(await adminDb(), c, { blob: "x".repeat(256001) }));
    await assertSucceeds(put(await adminDb(), c, { blob: "x".repeat(1000) }));
  });
  it("storey containedElementIds must be a list; elevation a number", async () => {
    const c = byName("storeys");
    const a = await adminDb();
    await assertFails(put(a, c, { containedElementIds: "nope" }));
    await assertFails(put(a, c, { elevation: "0" }));
  });
  it("building name must be non-empty text", async () => {
    const c = byName("buildings");
    const a = await adminDb();
    await assertFails(put(a, c, { name: "" }));
    await assertFails(put(a, c, { name: 5 }));
  });
});

describe("existing surfaces are untouched", () => {
  it("members still cannot write the project doc or the roster", async () => {
    const m = await memberDb();
    await assertFails(setDoc(doc(m, "projects/p1"), { name: "x" }));
    await assertFails(updateDoc(doc(m, `projects/p1/members/member1`), { role: "admin" }));
  });
});
