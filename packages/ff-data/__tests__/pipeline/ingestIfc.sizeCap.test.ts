import { describe, expect, it, vi } from "vitest";

import { ingestIfc, IfcTooLargeError, MAX_IFC_FILE_BYTES } from "../../src/pipeline/ingestIfc";

describe("ingestIfc size cap", () => {
  it("rejects an oversized IFC before reading or converting it", async () => {
    const convert = vi.fn();
    const arrayBuffer = vi.fn();
    const file = { name: "huge.ifc", size: MAX_IFC_FILE_BYTES + 1, arrayBuffer } as unknown as File;
    const err = await ingestIfc({
      file,
      target: { kind: "byName", buildingId: "b1" },
      dedupe: false,
      importHooks: { convert },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IfcTooLargeError);
    expect(String(err.message)).toMatch(/too large to import/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });
});
