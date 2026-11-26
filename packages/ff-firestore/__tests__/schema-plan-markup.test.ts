import { PlanMarkupSchema, SYNCED_COLLECTIONS } from "../src";
import { Timestamp } from "firebase/firestore";

const base = {
  id: "m1", projectId: "p", pdfFileId: "f", pdfVersionId: "v", page: 1, kind: "pen" as const,
  color: "#112233", strokeWidth: 0.004, shape: '{"pts":[[0,0],[1,1]]}', bbox: [0, 0, 1, 1],
  taskId: null, createdBy: "u", createdAt: 1,
  updatedAt: Timestamp.fromMillis(1), updatedBy: "u", deletedAt: null, schema: 1 as const,
};

describe("PlanMarkupSchema", () => {
  it("accepts a well-formed doc and a tombstone", () => {
    expect(PlanMarkupSchema.safeParse(base).success).toBe(true);
    expect(PlanMarkupSchema.safeParse({ ...base, deletedAt: Timestamp.fromMillis(2) }).success).toBe(true);
  });
  it.each([
    ["bad kind", { kind: "lasso" }],
    ["bad colour", { color: "red" }],
    ["zero width", { strokeWidth: 0 }],
    ["huge width", { strokeWidth: 1 }],
    ["page 0", { page: 0 }],
    ["bbox length", { bbox: [0, 0] }],
    ["oversized shape", { shape: "x".repeat(100_001) }],
    ["empty createdBy", { createdBy: "" }],
    ["wrong schema version", { schema: 2 }],
  ])("rejects %s", (_n, over) => {
    expect(PlanMarkupSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });
  it("is registered as a synced collection", () => {
    expect(SYNCED_COLLECTIONS).toContain("planMarkups");
  });
});
