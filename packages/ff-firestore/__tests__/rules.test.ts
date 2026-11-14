// @vitest-environment node
/**
 * Security rules unit tests for the FreeField two-role model (plan v4 §2).
 *
 * Uses @firebase/rules-unit-testing to spin up an in-memory Firestore
 * emulator and exercise firestore.rules. The matrix proves, for every
 * protected collection:
 *
 *   - unauthenticated read/write → DENY
 *   - member read → PASS (roster for members, admin-only for invitations)
 *   - member write → DENY
 *   - admin write → PASS on content collections (projects/buildings/folders);
 *     DENY on members/invitations/auditLog (mutations are functions-only)
 *   - invitations → admin-only client READ; functions-only WRITE
 *   - meta/bootstrap → deny-all client access
 *   - audit log → admin read only, no client writes
 *
 * Run from repo root (the package test script wraps the emulator):
 *   pnpm --filter @ff/firestore test
 *
 * v3 semantics (readRoles, custom roles, superadmin) are intentionally
 * absent — they were dropped in v4.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
  setLogLevel,
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

// ── Context helpers (v4 locked claims shape) ─────────────────────

function authedDb(uid: string, claims: Record<string, unknown> = {}): Firestore {
  return testEnv.authenticatedContext(uid, claims).firestore();
}

/**
 * Phase 1b: access comes from the member doc, not from claims. These
 * helpers seed `/projects/{pid}/members/{uid}` (rules disabled, merge so a
 * test's own roster seed survives) and return the signed-in client. NO
 * claims are set: authorization must work from the membership alone.
 */
async function seedMembership(
  uid: string,
  projectId: string,
  role: "admin" | "member",
  status = "active"
): Promise<void> {
  await seedDoc(`projects/${projectId}/members/${uid}`, {
    uid,
    role,
    status,
    joinedAt: 1,
    invitedBy: "bootstrap",
  });
}

async function adminDb(uid: string, projectId = "p1"): Promise<Firestore> {
  await seedMembership(uid, projectId, "admin");
  return authedDb(uid);
}

async function memberDb(uid: string, projectId = "p1"): Promise<Firestore> {
  await seedMembership(uid, projectId, "member");
  return authedDb(uid);
}

function verifiedUserDb(uid: string, email = `${uid}@example.com`): Firestore {
  return authedDb(uid, { email, email_verified: true });
}

function unauthDb(): Firestore {
  return testEnv.unauthenticatedContext().firestore();
}

/** Seed a document bypassing rules (admin SDK path emulation). */
async function seedDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data as never);
  });
}

// ────────────────────────────────────────────────────────────────────
// meta/bootstrap — deny-all client access (Cloud Function only)
// ────────────────────────────────────────────────────────────────────
describe("/meta/bootstrap", () => {
  it("blocks all client reads and writes (admin included)", async () => {
    const db = await adminDb("admin-uid");
    await assertFails(getDoc(doc(db, "meta/bootstrap")));
    await assertFails(setDoc(doc(db, "meta/bootstrap"), { status: "pending" }));
    await assertFails(getDoc(doc(unauthDb(), "meta/bootstrap")));
    await assertFails(setDoc(doc(unauthDb(), "meta/bootstrap"), { status: "pending" }));
  });
});

// ────────────────────────────────────────────────────────────────────
// /users/{uid} — public profile mirrored from Firebase Auth
// ────────────────────────────────────────────────────────────────────
describe("/users/{userId}", () => {
  // Wave 63: profile reads are scoped (they used to be any signed-in user).
  it("a user can read their OWN profile, even with no project", async () => {
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    await assertSucceeds(getDoc(doc(authedDb("alice"), "users/alice")));
  });

  it("a signed-in stranger (no shared project) CANNOT read another user's profile", async () => {
    await seedDoc("users/bob", { uid: "bob", email: "bob@example.com" });
    await seedDoc("projects/p1/members/bob", { role: "member", status: "active" });
    await assertFails(getDoc(doc(authedDb("alice"), "users/bob")));
    // member of a DIFFERENT project can't read p1's roster profiles either
    await seedMembership("carol", "p2", "member");
    await assertFails(getDoc(doc(authedDb("carol", { currentProject: { id: "p2", role: "member" } }), "users/bob")));
  });

  // Phase 1b: the claim only NAMES the project whose roster is readable;
  // the caller must also be an active member of it.
  it("a project member CAN read the profile of someone on the same roster (useMembers join)", async () => {
    await seedDoc("users/bob", { uid: "bob", email: "bob@example.com" });
    await seedDoc("projects/p1/members/bob", { role: "member", status: "active" });
    await seedMembership("alice", "p1", "member");
    await seedMembership("admin", "p1", "admin");
    const claim = { currentProject: { id: "p1", role: "member" } };
    await assertSucceeds(getDoc(doc(authedDb("alice", claim), "users/bob")));
    await assertSucceeds(getDoc(doc(authedDb("admin", claim), "users/bob")));
  });

  it("a forged currentProject claim without an active member doc reads no profiles", async () => {
    await seedDoc("users/bob", { uid: "bob", email: "bob@example.com" });
    await seedDoc("projects/p1/members/bob", { role: "member", status: "active" });
    const claim = { currentProject: { id: "p1", role: "admin" } };
    await assertFails(getDoc(doc(authedDb("mallory", claim), "users/bob")));
    await seedMembership("removed", "p1", "member", "removed");
    await assertFails(getDoc(doc(authedDb("removed", claim), "users/bob")));
  });

  it("profile list queries are denied (no directory scraping)", async () => {
    await seedDoc("users/bob", { uid: "bob", email: "bob@example.com" });
    await assertFails(getDocs(collection(await memberDb("alice", "p1"), "users")));
  });

  it("unauthenticated reads are blocked", async () => {
    await assertFails(getDoc(doc(unauthDb(), "users/bob")));
  });

  it("user can write their own profile", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertSucceeds(
      setDoc(doc(db, "users/alice"), { uid: "alice", email: "alice@example.com" })
    );
  });

  it("user CANNOT write another user's profile", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(
      setDoc(doc(db, "users/bob"), { uid: "bob", email: "bob@example.com" })
    );
  });

  // ── P0-1 field invariants (email-of-record pinned to token identity) ──
  it("email-pinned create PASSES (email == token email, uid == self)", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertSucceeds(
      setDoc(doc(db, "users/alice"), { uid: "alice", email: "alice@example.com" })
    );
  });

  it("forged-email create is DENIED (email != token email)", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(
      setDoc(doc(db, "users/alice"), { uid: "alice", email: "victim@example.com" })
    );
  });

  it("update to a foreign email is DENIED (email != token email)", async () => {
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(updateDoc(doc(db, "users/alice"), { email: "new@example.com" }));
  });

  it("update to own new token email PASSES (self-heal after a legitimate email change)", async () => {
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    const db = verifiedUserDb("alice", "alice2@example.com");
    await assertSucceeds(updateDoc(doc(db, "users/alice"), { email: "alice2@example.com" }));
  });

  // Wave 63: field allowlist on profile writes.
  it("the FinishSignInPage write shape passes ({ uid, email, createdAt } with merge)", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertSucceeds(
      setDoc(
        doc(db, "users/alice"),
        { uid: "alice", email: "alice@example.com", createdAt: 1 },
        { merge: true }
      )
    );
    // second sign-in re-runs the same merge write (update path)
    await assertSucceeds(
      setDoc(
        doc(db, "users/alice"),
        { uid: "alice", email: "alice@example.com", createdAt: 2 },
        { merge: true }
      )
    );
  });

  it("profile create/update with unknown fields is DENIED", async () => {
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(
      setDoc(doc(db, "users/alice"), { uid: "alice", email: "alice@example.com", role: "admin" })
    );
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    await assertFails(
      updateDoc(doc(db, "users/alice"), { email: "alice@example.com", isAdmin: true })
    );
    // allowlisted optional fields are fine
    await assertSucceeds(
      updateDoc(doc(db, "users/alice"), { email: "alice@example.com", displayName: "Alice" })
    );
  });

  it("update cannot change the uid field", async () => {
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(
      updateDoc(doc(db, "users/alice"), { uid: "bob", email: "alice@example.com" })
    );
  });

  it("delete is DENIED (profile docs are immutable, trigger non-re-armable)", async () => {
    await seedDoc("users/alice", { uid: "alice", email: "alice@example.com" });
    const db = verifiedUserDb("alice", "alice@example.com");
    await assertFails(deleteDoc(doc(db, "users/alice")));
  });
});

// ────────────────────────────────────────────────────────────────────
// Shared matrix for member-readable / admin-writable content collections
// ────────────────────────────────────────────────────────────────────
type ContentCase = { describeName: string; path: string; data: Record<string, unknown> };

const CONTENT_COLLECTIONS: ContentCase[] = [
  { describeName: "/projects/{pid}", path: "projects/p1", data: { name: "Acme HQ" } },
  {
    describeName: "/projects/{pid}/buildings/{bid}",
    path: "projects/p1/buildings/b1",
    data: { name: "Tower A" },
  },
  {
    describeName: "/projects/{pid}/folders/{fid}",
    path: "projects/p1/folders/f1",
    data: { name: "MEP", parentId: null },
  },
];

for (const c of CONTENT_COLLECTIONS) {
  describe(c.describeName, () => {
    it("member can read", async () => {
      await seedDoc(c.path, c.data);
      await assertSucceeds(getDoc(doc(await memberDb("alice", "p1"), c.path)));
    });

    it("admin can read", async () => {
      await seedDoc(c.path, c.data);
      await assertSucceeds(getDoc(doc(await adminDb("alice", "p1"), c.path)));
    });

    it("member CANNOT write", async () => {
      await assertFails(setDoc(doc(await memberDb("alice", "p1"), c.path), c.data));
    });

    it("admin CAN write", async () => {
      await assertSucceeds(setDoc(doc(await adminDb("alice", "p1"), c.path), c.data));
    });

    it("unauthenticated read is denied", async () => {
      await seedDoc(c.path, c.data);
      await assertFails(getDoc(doc(unauthDb(), c.path)));
    });

    it("unauthenticated write is denied", async () => {
      await assertFails(setDoc(doc(unauthDb(), c.path), c.data));
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// /projects/{pid}/members/{uid} — roster read, functions-only write
// ────────────────────────────────────────────────────────────────────
describe("/projects/{pid}/members/{uid}", () => {
  const MEMBER_DATA = {
    role: "member",
    joinedAt: Date.now(),
    invitedBy: "alice",
    status: "active",
  };

  it("member can read their OWN member doc (self-read)", async () => {
    await seedDoc("projects/p1/members/alice", MEMBER_DATA);
    await assertSucceeds(getDoc(doc(await memberDb("alice", "p1"), "projects/p1/members/alice")));
  });

  it("member CAN read another member's doc (roster reads are the assignment surface)", async () => {
    await seedDoc("projects/p1/members/bob", MEMBER_DATA);
    await assertSucceeds(getDoc(doc(await memberDb("alice", "p1"), "projects/p1/members/bob")));
  });

  it("member can run the roster collection query the assignee picker depends on (S3 fix)", async () => {
    await seedDoc("projects/p1/members/alice", MEMBER_DATA);
    await seedDoc("projects/p1/members/bob", MEMBER_DATA);
    const db = await memberDb("alice", "p1");
    await assertSucceeds(
      getDocs(query(collection(db, "projects/p1/members"), where("status", "==", "active")))
    );
  });

  it("member of ANOTHER project cannot read a member doc (cross-project isolation)", async () => {
    await seedDoc("projects/p1/members/bob", MEMBER_DATA);
    await assertFails(getDoc(doc(await memberDb("alice", "p2"), "projects/p1/members/bob")));
  });

  it("admin can read any member doc", async () => {
    await seedDoc("projects/p1/members/bob", MEMBER_DATA);
    await assertSucceeds(getDoc(doc(await adminDb("alice", "p1"), "projects/p1/members/bob")));
  });

  it("member CANNOT create/write a member doc", async () => {
    await assertFails(
      setDoc(doc(await memberDb("alice", "p1"), "projects/p1/members/eve"), MEMBER_DATA)
    );
  });

  it("admin CANNOT write a member doc (mutations via functions only)", async () => {
    await assertFails(
      setDoc(doc(await adminDb("alice", "p1"), "projects/p1/members/bob"), MEMBER_DATA)
    );
  });

  it("unauthenticated read is denied", async () => {
    await seedDoc("projects/p1/members/alice", MEMBER_DATA);
    await assertFails(getDoc(doc(unauthDb(), "projects/p1/members/alice")));
  });

  it("unauthenticated write is denied", async () => {
    await assertFails(
      setDoc(doc(unauthDb(), "projects/p1/members/eve"), MEMBER_DATA)
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// /projects/{pid}/invitations/{iid} — admin-only read; functions-only write
// ────────────────────────────────────────────────────────────────────
describe("/projects/{pid}/invitations/{iid}", () => {
  const INVITE_DATA = {
    email: "new@example.com",
    role: "member",
    invitedBy: "alice",
    invitedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    status: "pending",
  };

  it("admin can read invitations", async () => {
    await seedDoc("projects/p1/invitations/inv1", INVITE_DATA);
    await assertSucceeds(getDoc(doc(await adminDb("alice", "p1"), "projects/p1/invitations/inv1")));
  });

  it("member CANNOT read invitations (admin-only)", async () => {
    await seedDoc("projects/p1/invitations/inv1", INVITE_DATA);
    await assertFails(getDoc(doc(await memberDb("alice", "p1"), "projects/p1/invitations/inv1")));
  });

  it("admin CANNOT write an invitation doc (mutations via functions only)", async () => {
    await assertFails(
      setDoc(doc(await adminDb("alice", "p1"), "projects/p1/invitations/inv1"), INVITE_DATA)
    );
  });

  it("member CANNOT write invitations", async () => {
    await assertFails(
      setDoc(doc(await memberDb("alice", "p1"), "projects/p1/invitations/inv1"), INVITE_DATA)
    );
  });

  it("unauthenticated read is denied", async () => {
    await seedDoc("projects/p1/invitations/inv1", INVITE_DATA);
    await assertFails(getDoc(doc(unauthDb(), "projects/p1/invitations/inv1")));
  });

  it("unauthenticated write is denied", async () => {
    await assertFails(
      setDoc(doc(unauthDb(), "projects/p1/invitations/inv1"), INVITE_DATA)
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// /projects/{pid}/auditLog/{entryId} — admin read, no client writes
// ────────────────────────────────────────────────────────────────────
describe("/projects/{pid}/auditLog/{entryId}", () => {
  const LOG_DATA = {
    actorUid: "alice",
    actorEmail: "alice@example.com",
    actorRole: "admin",
    action: "test.action",
    targetType: "test",
    targetId: "test",
    details: {},
    timestamp: Date.now(),
  };

  it("admin can read audit log", async () => {
    await seedDoc("projects/p1/auditLog/e1", LOG_DATA);
    await assertSucceeds(getDoc(doc(await adminDb("alice", "p1"), "projects/p1/auditLog/e1")));
  });

  it("member CANNOT read audit log (admin-only)", async () => {
    await seedDoc("projects/p1/auditLog/e1", LOG_DATA);
    await assertFails(getDoc(doc(await memberDb("alice", "p1"), "projects/p1/auditLog/e1")));
  });

  it("client write to audit log is blocked (admin included)", async () => {
    await assertFails(
      setDoc(doc(await adminDb("alice", "p1"), "projects/p1/auditLog/e1"), LOG_DATA)
    );
  });

  it("unauthenticated read is denied", async () => {
    await seedDoc("projects/p1/auditLog/e1", LOG_DATA);
    await assertFails(getDoc(doc(unauthDb(), "projects/p1/auditLog/e1")));
  });
});

// ────────────────────────────────────────────────────────────────────
// Cross-project isolation
// ────────────────────────────────────────────────────────────────────
describe("cross-project isolation", () => {
  it("admin of project A cannot read project B's resources", async () => {
    await seedDoc("projects/p2/buildings/b1", { name: "Project B Tower" });
    await assertFails(getDoc(doc(await adminDb("alice", "p1"), "projects/p2/buildings/b1")));
  });

  it("admin of project A cannot write project B's resources", async () => {
    await assertFails(
      setDoc(doc(await adminDb("alice", "p1"), "projects/p2/buildings/b1"), { name: "Sneaky" })
    );
  });
});