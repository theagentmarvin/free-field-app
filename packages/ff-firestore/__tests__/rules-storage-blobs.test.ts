// @vitest-environment node
/**
 * Phase 1d blob rules (repo-root storage.rules, docs/SPEC-PHASE-1.md §4/§8):
 * projects/{pid}/{pdf,frag,ifc}/{versionId}.{ext}
 *   - members read; admins create; nobody updates or deletes from a client;
 *   - create-only (an overwrite is denied even for an admin);
 *   - size caps (pdf 200 MB, frag 500 MB, ifc 1 GB) and content types;
 *   - the object name must be {versionId}.{ext} for its folder.
 *
 * Oversize denial is tested in rules-storage-caps.test.ts (scaled-down copy
 * of these rules; see the comment there for why).
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BLOB_MAX_BYTES,
  blobStoragePath,
  fragStoragePath,
  ifcStoragePath,
  pdfStoragePath,
} from "../src";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_RULES = readFileSync(join(__dirname, "..", "..", "..", "storage.rules"), "utf8");

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-freefield",
    storage: { rules: STORAGE_RULES },
    firestore: { rules: readFileSync(join(__dirname, "..", "firestore.rules"), "utf8") },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
beforeEach(async () => {
  await testEnv.clearStorage();
  await testEnv.clearFirestore();
});

async function seedMember(uid: string, pid: string, role: string, status = "active") {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `projects/${pid}/members/${uid}`), {
      uid, role, status, joinedAt: 1, invitedBy: "bootstrap",
    });
  });
}
const member = async (uid = "m1", pid = "p1") => {
  await seedMember(uid, pid, "member");
  return testEnv.authenticatedContext(uid).storage();
};
const admin = async (uid = "a1", pid = "p1") => {
  await seedMember(uid, pid, "admin");
  return testEnv.authenticatedContext(uid).storage();
};
const removedAdmin = async () => {
  await seedMember("gone", "p1", "admin", "removed");
  return testEnv.authenticatedContext("gone").storage();
};
const stranger = () => testEnv.authenticatedContext("stranger").storage();
const anon = () => testEnv.unauthenticatedContext().storage();

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const OCTET = { contentType: "application/octet-stream" };
const PDF = { contentType: "application/pdf" };

async function seedObject(path: string, contentType: string): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), BYTES, { contentType });
  });
}

const KINDS = [
  { kind: "pdf" as const, path: pdfStoragePath("p1", "v1"), meta: PDF, wrongMeta: OCTET },
  { kind: "frag" as const, path: fragStoragePath("p1", "v1"), meta: OCTET, wrongMeta: PDF },
  { kind: "ifc" as const, path: ifcStoragePath("p1", "v1"), meta: OCTET, wrongMeta: PDF },
];

describe("path helpers", () => {
  it("build projects/{pid}/{kind}/{versionId}.{ext}", () => {
    expect(blobStoragePath("p", "pdf", "v")).toBe("projects/p/pdf/v.pdf");
    expect(blobStoragePath("p", "frag", "v")).toBe("projects/p/frag/v.frag");
    expect(blobStoragePath("p", "ifc", "v")).toBe("projects/p/ifc/v.ifc");
  });
  it("caps in the helpers match storage.rules", () => {
    expect(STORAGE_RULES).toContain(`request.resource.size <= ${BLOB_MAX_BYTES.pdf / (1024 * 1024)} * 1024 * 1024`);
    expect(STORAGE_RULES).toContain(`request.resource.size <= ${BLOB_MAX_BYTES.frag / (1024 * 1024)} * 1024 * 1024`);
    expect(STORAGE_RULES).toContain("request.resource.size <= 1024 * 1024 * 1024");
  });
});

for (const k of KINDS) {
  describe(`storage — ${k.kind} blobs`, () => {
    it("admin can create; any active member can read it back", async () => {
      await assertSucceeds(uploadBytes(ref(await admin(), k.path), BYTES, k.meta));
      await assertSucceeds(getBytes(ref(await member("m2"), k.path)));
      await assertSucceeds(getBytes(ref(await admin("a2"), k.path)));
    });

    it("member, non-member, removed admin, other-project admin and anonymous cannot create", async () => {
      await assertFails(uploadBytes(ref(await member(), k.path), BYTES, k.meta));
      await assertFails(uploadBytes(ref(stranger(), k.path), BYTES, k.meta));
      await assertFails(uploadBytes(ref(await removedAdmin(), k.path), BYTES, k.meta));
      await assertFails(uploadBytes(ref(await admin("o", "p2"), k.path), BYTES, k.meta));
      await assertFails(uploadBytes(ref(anon(), k.path), BYTES, k.meta));
    });

    it("non-member, removed member, other-project member and anonymous cannot read", async () => {
      await seedObject(k.path, k.meta.contentType);
      await assertFails(getBytes(ref(stranger(), k.path)));
      await assertFails(getBytes(ref(await removedAdmin(), k.path)));
      await assertFails(getBytes(ref(await member("x", "p2"), k.path)));
      await assertFails(getBytes(ref(anon(), k.path)));
    });

    it("overwrite is denied, even for an admin (immutable object)", async () => {
      await seedObject(k.path, k.meta.contentType);
      await assertFails(uploadBytes(ref(await admin(), k.path), new Uint8Array([9, 9]), k.meta));
    });

    it("client delete is denied for admin and member (GC is Admin-SDK only)", async () => {
      await seedObject(k.path, k.meta.contentType);
      await assertFails(deleteObject(ref(await admin(), k.path)));
      await assertFails(deleteObject(ref(await member(), k.path)));
    });

    it("wrong content type is rejected", async () => {
      await assertFails(uploadBytes(ref(await admin(), k.path), BYTES, k.wrongMeta));
      await assertFails(uploadBytes(ref(await admin(), k.path), BYTES, { contentType: "text/html" }));
    });

    it("a file name that is not {versionId}.{ext} for this folder is rejected", async () => {
      const a = await admin();
      await assertFails(uploadBytes(ref(a, `projects/p1/${k.kind}/v1.exe`), BYTES, k.meta));
      await assertFails(uploadBytes(ref(a, `projects/p1/${k.kind}/v1`), BYTES, k.meta));
      await assertFails(uploadBytes(ref(a, `projects/p1/${k.kind}/sub/v1.${k.kind}`), BYTES, k.meta));
    });
  });
}

describe("storage — unchanged surfaces", () => {
  it("other kinds under a project stay denied", async () => {
    const a = await admin();
    await assertFails(uploadBytes(ref(a, "projects/p1/docs/v1.pdf"), BYTES, PDF));
    await assertFails(uploadBytes(ref(a, "stray.pdf"), BYTES, PDF));
  });
});
