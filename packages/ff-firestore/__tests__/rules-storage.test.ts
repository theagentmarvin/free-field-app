// @vitest-environment node
/**
 * Storage security rules (repo-root storage.rules), wave 63.
 *
 * The deployed rules used to end in an open `allow read, write: if true`
 * catch-all. These tests pin:
 *   - task photos / location thumb (the only Storage paths the app uses,
 *     see packages/ff-tasks/src/{repository,photos}.ts) keep working for
 *     project members, with the size / content-type / immutability guards;
 *   - every other path is denied, signed in or not.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, "..", "..", "..", "storage.rules");

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-freefield",
    storage: { rules: readFileSync(RULES_PATH, "utf8") },
    // Phase 1b: storage rules read the Firestore member doc.
    firestore: { rules: readFileSync(join(__dirname, "..", "firestore.rules"), "utf8") },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearStorage();
});

// Phase 1b: access comes from the Firestore member doc, not from claims.
async function seedMember(uid: string, pid: string, role: string, status = "active"): Promise<void> {
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
const signedInNoProject = () => testEnv.authenticatedContext("stranger").storage();
const anon = () => testEnv.unauthenticatedContext().storage();

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PHOTO = "projects/p1/tasks/t1/abcdef012345-0.jpg";
const THUMB = "projects/p1/tasks/t1/location-thumb.jpg";

async function seed(path: string, contentType = "image/jpeg"): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), JPEG, { contentType });
  });
}

describe("storage — task photos (members)", () => {
  it("member can upload a photo and the location thumb, then read them back", async () => {
    await assertSucceeds(uploadBytes(ref(await member(), PHOTO), JPEG, { contentType: "image/jpeg" }));
    await assertSucceeds(uploadBytes(ref(await member(), THUMB), JPEG, { contentType: "image/jpeg" }));
    await assertSucceeds(getBytes(ref(await member("m2"), PHOTO)));
  });

  it("png / webp photos are allowed; non-image content types are not", async () => {
    await assertSucceeds(
      uploadBytes(ref(await member(), "projects/p1/tasks/t1/aa-1.png"), JPEG, { contentType: "image/png" })
    );
    await assertSucceeds(
      uploadBytes(ref(await member(), "projects/p1/tasks/t1/aa-2.webp"), JPEG, { contentType: "image/webp" })
    );
    await assertFails(
      uploadBytes(ref(await member(), "projects/p1/tasks/t1/x.html"), JPEG, { contentType: "text/html" })
    );
  });

  it("photos are immutable (no overwrite) and only admins delete", async () => {
    await seed(PHOTO);
    await assertFails(uploadBytes(ref(await member(), PHOTO), JPEG, { contentType: "image/jpeg" }));
    await assertFails(deleteObject(ref(await member(), PHOTO)));
    await assertSucceeds(deleteObject(ref(await admin(), PHOTO)));
  });

  it("other-project members, project-less users and anonymous callers are denied", async () => {
    await seed(PHOTO);
    await assertFails(getBytes(ref(await member("x", "p2"), PHOTO)));
    await assertFails(getBytes(ref(signedInNoProject(), PHOTO)));
    await assertFails(getBytes(ref(anon(), PHOTO)));
    await assertFails(
      uploadBytes(ref(anon(), "projects/p1/tasks/t1/z-0.jpg"), JPEG, { contentType: "image/jpeg" })
    );
  });
});

describe("storage — membership-doc authorization (Phase 1b)", () => {
  it("a removed / pending member doc grants nothing; claims alone grant nothing", async () => {
    await seed(PHOTO);
    await seedMember("gone", "p1", "admin", "removed");
    await seedMember("wait", "p1", "member", "pending-acceptance");
    await assertFails(getBytes(ref(testEnv.authenticatedContext("gone").storage(), PHOTO)));
    await assertFails(getBytes(ref(testEnv.authenticatedContext("wait").storage(), PHOTO)));
    const forged = testEnv.authenticatedContext("mallory", {
      currentProject: { id: "p1", role: "admin" },
    });
    await assertFails(getBytes(ref(forged.storage(), PHOTO)));
    await assertFails(deleteObject(ref(forged.storage(), PHOTO)));
  });

  it("a user in two projects reads photos of both; admin rights are per project", async () => {
    await seedMember("u", "p1", "member");
    await seedMember("u", "p2", "admin");
    const s = testEnv.authenticatedContext("u").storage();
    await seed(PHOTO);
    await seed("projects/p2/tasks/t9/ab-0.jpg");
    await assertSucceeds(getBytes(ref(s, PHOTO)));
    await assertSucceeds(getBytes(ref(s, "projects/p2/tasks/t9/ab-0.jpg")));
    await assertFails(deleteObject(ref(s, PHOTO)));
    await assertSucceeds(deleteObject(ref(s, "projects/p2/tasks/t9/ab-0.jpg")));
  });

  it("revocation is immediate: deleting the member doc cuts access with the same token", async () => {
    await seed(PHOTO);
    const s = await member("m7");
    await assertSucceeds(getBytes(ref(s, PHOTO)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "projects/p1/members/m7"));
    });
    await assertFails(getBytes(ref(s, PHOTO)));
  });
});

describe("storage — default deny (the old open catch-all is gone)", () => {
  const OTHER = ["models/a.ifc", "pdfs/plan.pdf", "projects/p1/anything.bin", "random/path.txt"];

  it("anonymous read/write anywhere else is denied", async () => {
    for (const p of OTHER) {
      await assertFails(uploadBytes(ref(anon(), p), JPEG, { contentType: "image/jpeg" }));
    }
    await seed("random/path.txt");
    await assertFails(getBytes(ref(anon(), "random/path.txt")));
  });

  it("even a project admin cannot read/write outside the task media paths", async () => {
    for (const p of OTHER) {
      await assertFails(uploadBytes(ref(await admin(), p), JPEG, { contentType: "image/jpeg" }));
    }
    await seed("projects/p1/anything.bin");
    await assertFails(getBytes(ref(await admin(), "projects/p1/anything.bin")));
  });
});
