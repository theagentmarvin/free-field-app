import { describe, expect, it } from "vitest";
import { calibrationDocId } from "@ff/firestore";

import { fromDocData, toDocData } from "../src/adapter";
import { MAX_CONTAINED_IDS, TABLES, TABLE_BY_COLLECTION } from "../src/tables";

const pt = { pdfX: 1, pdfY: 2, worldX: 3, worldZ: 4 };

const ROWS: Record<string, Record<string, unknown>> = {
  buildings: { id: "b1", projectId: "p", name: "A", metadata: {}, createdAt: 1, updatedAt: 2 },
  folders: { id: "f1", projectId: "p", parentId: null, name: "Arch", color: "blue", createdAt: 1, updatedAt: 2 },
  ifcFiles: { id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "", createdAt: 1, updatedAt: 2 },
  pdfFiles: { id: "d1", buildingId: "b1", name: "p.pdf", createdAt: 1, updatedAt: 2 },
  ifcVersions: { id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 5, contentHash: "h", fragBlobKey: "k", storeyCount: 2, createdAt: 1, isLatest: true },
  pdfVersions: {
    id: "pv1", pdfFileId: "d1", versionNumber: 1, name: "p.pdf", size: 7, contentHash: "h", pageCount: 1, width: 10, height: 20,
    storedAt: 1, blobKey: "bk", isLatest: true, storagePath: "projects/p/pdf/pv1.pdf", sha256: "a".repeat(64),
  },
  storeys: { id: "s1", buildingId: "b1", ifcVersionId: "v1", sourceIfcFileId: "i1", name: "L1", elevation: 0, expressId: 3, height: null, containedElementIds: [1, 2] },
  extractedStoreys: { id: "e1", buildingId: "b1", storeyId: "s1", updatedAt: 2 },
  calibrations: {
    id: "local-uuid", projectId: "p", pdfFileId: "d1", storeyName: "Level 1/A", pointPairs: [pt, pt],
    transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 }, confidence: 1, createdAt: 1, updatedAt: 2,
  },
  folderAssignments: { id: "local-uuid", pdfFileId: "d1", folderId: "f1", createdAt: 1 },
  viewpoints: { id: "vp1", projectId: "p", name: "V", createdAt: 1, blob: "{}" },
  planMarkups: {
    id: "m1", projectId: "p", pdfFileId: "d1", pdfVersionId: "pv1", page: 1, kind: "arrow", color: "#d94141",
    strokeWidth: 0.003, shape: '{"pts":[[0.1,0.1],[0.4,0.3]]}', bbox: [0.1, 0.1, 0.4, 0.3], taskId: null,
    createdBy: "u1", createdAt: 1,
  },
};

describe("generic adapter", () => {
  it("covers all 12 collections", () => {
    expect(TABLES.map((t) => t.collection).sort()).toEqual(Object.keys(ROWS).sort());
  });

  for (const cfg of TABLES) {
    it(`${cfg.collection}: row -> doc validates and drops local-only fields`, () => {
      const doc = toDocData(cfg, { ...ROWS[cfg.collection], remoteUpdatedAt: 5 });
      expect(doc).not.toHaveProperty("remoteUpdatedAt");
      expect(doc).not.toHaveProperty("updatedAt");
      expect(doc.id).toBe(cfg.docId(ROWS[cfg.collection]));
    });

    it(`${cfg.collection}: doc -> row sets remoteUpdatedAt${cfg.hasUpdatedAt ? " + updatedAt" : ""}`, () => {
      const data = toDocData(cfg, ROWS[cfg.collection]);
      const row = fromDocData(cfg, String(data.id), data, 777, undefined);
      expect(row.remoteUpdatedAt).toBe(777);
      expect(row.updatedAt).toBe(cfg.hasUpdatedAt ? 777 : undefined);
      expect(row.id).toBe(cfg.newLocalId ? cfg.newLocalId(String(data.id), data) : data.id);
    });
  }

  it("calibration doc id is deterministic and percent-encodes the storey", () => {
    const cfg = TABLE_BY_COLLECTION.calibrations;
    expect(cfg.docId(ROWS.calibrations)).toBe(calibrationDocId("d1", "Level 1/A"));
    expect(cfg.docId(ROWS.calibrations)).not.toContain("/");
    // Two devices with different local uuids -> the same doc id.
    expect(cfg.docId({ ...ROWS.calibrations, id: "other" })).toBe(cfg.docId(ROWS.calibrations));
  });

  it("folderAssignments: doc id and new local id are the pdfFileId", () => {
    const cfg = TABLE_BY_COLLECTION.folderAssignments;
    expect(cfg.docId(ROWS.folderAssignments)).toBe("d1");
    expect(cfg.newLocalId!("d1", {})).toBe("d1");
  });

  it("ifcVersions blob groups default to null; pdfVersions fills sizeBytes/contentType", () => {
    const iv = toDocData(TABLE_BY_COLLECTION.ifcVersions, ROWS.ifcVersions);
    expect(iv).toMatchObject({ fragStoragePath: null, fragSha256: null, fragSizeBytes: null, sha256: null });
    const pv = toDocData(TABLE_BY_COLLECTION.pdfVersions, ROWS.pdfVersions);
    expect(pv).toMatchObject({ sizeBytes: 7, contentType: "application/pdf" });
  });

  it("storeys: oversized containedElementIds are sent empty", () => {
    const big = Array.from({ length: MAX_CONTAINED_IDS + 1 }, (_, i) => i);
    const doc = toDocData(TABLE_BY_COLLECTION.storeys, { ...ROWS.storeys, containedElementIds: big });
    expect(doc.containedElementIds).toEqual([]);
  });

  it("rejects an invalid row (never sends a doc the rules would deny)", () => {
    expect(() => toDocData(TABLE_BY_COLLECTION.buildings, { ...ROWS.buildings, name: "" })).toThrow();
  });
});
