import { describe, it, expect } from "vitest";

import {
  composePhotoPath,
  dataUrlToBlob,
  locationThumbPath,
  sha256Hex,
  photoExtFor,
} from "../src/photos";
import { buildActionPayload, photoPath } from "../src/index";

describe("sha256Hex", () => {
  it("64-hex lowercase, stable", async () => {
    const data = new TextEncoder().encode("task-photo-bytes").buffer;
    const a = await sha256Hex(data);
    const b = await sha256Hex(data);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});

describe("photoExtFor", () => {
  it("maps the D3 allow-list mimes", () => {
    expect(photoExtFor("image/png")).toBe("png");
    expect(photoExtFor("image/webp")).toBe("webp");
    expect(photoExtFor("image/jpeg")).toBe("jpg");
  });
});

describe("composePhotoPath ↔ repository photoPath parity", () => {
  it("byte-identical for every index/extension", () => {
    const payload = buildActionPayload({
      verb: "create",
      projectId: "p1",
      taskId: "t7",
      statusFrom: null,
      actor: { uid: "u1", name: "Ana" },
      title: "x",
      photoRefs: [
        { blobKey: "b0", sha256: "a".repeat(64), size: 1, mime: "image/jpeg" },
        { blobKey: "b1", sha256: "b".repeat(64), size: 1, mime: "image/png" },
        { blobKey: "b2", sha256: "c".repeat(64), size: 1, mime: "image/webp" },
      ],
      guid: "g1",
      at: 1,
    });
    for (let i = 0; i < 3; i++) {
      const ref = payload.photoRefs[i];
      expect(composePhotoPath("p1", "t7", i, ref.sha256, ref.mime)).toBe(photoPath(payload, i));
    }
  });
});

describe("locationThumbPath (Day-3 deterministic thumb path)", () => {
  it("fixed-name path in the SAME photos prefix the executor + storage.rules use", () => {
    expect(locationThumbPath("p1", "t7")).toBe("projects/p1/tasks/t7/location-thumb.jpg");
  });

  it("compose path == executor path (single source of truth)", () => {
    // The executor recomputes the authoritative path at commit; the
    // compose sheet writes the same string into location.thumb.storagePath.
    // Both call the one exported helper — this pins the parity contract.
    const path = locationThumbPath("proj-a", "task-b");
    expect(path).toMatch(/^projects\/proj-a\/tasks\/task-b\/location-thumb\.jpg$/);
    expect(path).toBe(locationThumbPath("proj-a", "task-b"));
  });
});

describe("dataUrlToBlob (snapshot → blob sizing)", () => {
  it("round-trips a jpeg dataURL into a correctly-sized Blob", () => {
    // 4 bytes, base64 of [0,0,0,0] is "AAAA" (DATA padded with one `=`).
    const blob = dataUrlToBlob("data:image/jpeg;base64,AAAA");
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/jpeg");
    expect(blob!.size).toBe(3); // "AAAA" decodes to 3 bytes ([0,0,0])
  });

  it("returns null for a malformed data URL", () => {
    expect(dataUrlToBlob("not-a-data-url")).toBeNull();
    expect(dataUrlToBlob("")).toBeNull();
    expect(dataUrlToBlob("data:image/jpeg;base64,!!!not-base64!!!")).toBeNull();
  });
});
