// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { TaskLocation } from "@ff/firestore";

import { attachSnapshotThumb } from "../src/snapshot";
import { locationThumbPath } from "@ff/tasks";

const location: TaskLocation = {
  storeyName: "L1",
  bim: {
    elements: [{ modelId: "m1", expressId: 7 }],
    worldPoint: [1, 2, 3],
    cameraPose: { pos: [0, 0, 5], target: [1, 2, 3], fov: 45, isOrtho: false },
  },
  pdf: null,
};

describe("attachSnapshotThumb (capture seam)", () => {
  it("null dataURL (failed capture) preserves the location and yields no thumb", () => {
    const { location: out, thumb } = attachSnapshotThumb(null, "p1", "t1", location);
    expect(thumb).toBeNull();
    expect(out).toBe(location); // unchanged — placeholder + task still creatable
    expect(out.thumb).toBeUndefined();
  });

  it("a valid jpeg dataURL stamps the storagePath and a blob ref", () => {
    const { location: out, thumb } = attachSnapshotThumb(
      "data:image/jpeg;base64,AAAA",
      "p1",
      "t1",
      location,
    );
    expect(out.thumb?.storagePath).toBe(locationThumbPath("p1", "t1"));
    expect(thumb).not.toBeNull();
    expect(thumb!.mime).toBe("image/jpeg");
    expect(thumb!.size).toBe(3);
    expect(thumb!.blobKey).toBeTruthy();
    // the original location fields are preserved alongside the new thumb
    expect(out.bim?.elements).toEqual(location.bim!.elements);
  });

  it("malformed dataURL behaves exactly like a failed capture (null thumb)", () => {
    const { location: out, thumb } = attachSnapshotThumb(
      "garbage",
      "p1",
      "t1",
      location,
    );
    expect(thumb).toBeNull();
    expect(out).toBe(location);
  });
});