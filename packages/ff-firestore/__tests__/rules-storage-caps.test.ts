// @vitest-environment node
/**
 * Size-cap logic of the Phase 1d blob rules (repo-root storage.rules).
 * Separate file because it loads its own (scaled) copy of the rules into the
 * emulator; files run sequentially (--no-file-parallelism).
 */
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, uploadBytes } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blobStoragePath } from "../src";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_RULES = readFileSync(join(__dirname, "..", "..", "..", "storage.rules"), "utf8");
const OCTET = { contentType: "application/octet-stream" };
const PDF = { contentType: "application/pdf" };

/**
 * The emulator's HTTP layer rejects bodies of this size with a 413 before the
 * rules run (so a real 200 MB upload cannot produce PERMISSION_DENIED), and a
 * 1 GB buffer is unsafe on the 7 GB dev box. So the cap LOGIC is exercised on a
 * copy of storage.rules whose three caps are scaled down (200 MB -> 100 B,
 * 500 MB -> 200 B, 1 GB -> 300 B); the production numbers are pinned by the
 * "caps in the helpers match storage.rules" assertions above.
 */
describe("storage — size caps (rules copy with scaled-down caps)", () => {
  let small: RulesTestEnvironment;
  beforeAll(async () => {
    const scaled = STORAGE_RULES
      .replace("request.resource.size <= 200 * 1024 * 1024", "request.resource.size <= 100")
      .replace("request.resource.size <= 500 * 1024 * 1024", "request.resource.size <= 200")
      .replace("request.resource.size <= 1024 * 1024 * 1024", "request.resource.size <= 300");
    expect(scaled).not.toBe(STORAGE_RULES);
    expect((scaled.match(/request\.resource\.size <= (100|200|300)\b/g) ?? []).length).toBe(3);
    small = await initializeTestEnvironment({
      projectId: "demo-freefield",
      storage: { rules: scaled },
      firestore: { rules: readFileSync(join(__dirname, "..", "firestore.rules"), "utf8") },
    });
    await small.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "projects/p1/members/a1"), {
        uid: "a1", role: "admin", status: "active", joinedAt: 1, invitedBy: "bootstrap",
      });
    });
  });
  afterAll(async () => {
    await small.cleanup();
  });

  const cases = [
    { kind: "pdf" as const, cap: 100, meta: PDF },
    { kind: "frag" as const, cap: 200, meta: OCTET },
    { kind: "ifc" as const, cap: 300, meta: OCTET },
  ];
  for (const c of cases) {
    it(`${c.kind}: exactly the cap passes, cap + 1 is denied`, async () => {
      const s = small.authenticatedContext("a1").storage();
      await assertSucceeds(
        uploadBytes(ref(s, blobStoragePath("p1", c.kind, "ok")), new Uint8Array(c.cap), c.meta)
      );
      await assertFails(
        uploadBytes(ref(s, blobStoragePath("p1", c.kind, "big")), new Uint8Array(c.cap + 1), c.meta)
      );
    });
  }
});

