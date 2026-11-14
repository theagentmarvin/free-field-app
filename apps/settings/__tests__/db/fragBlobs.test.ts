// __tests__/db/fragBlobs.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  putFragBlob,
  getFragBlob,
  deleteFragBlob,
} from "@ff/data/db/tables/fragBlobs";
import { resetDb } from "./helpers";

describe("fragBlobs table", () => {
  beforeEach(async () => {
    await resetDb("fragBlobs");
  });

  it("put + get round-trips a Blob", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
      type: "application/octet-stream",
    });
    await putFragBlob("k1", blob);
    const got = await getFragBlob("k1");
    expect(got).toBeDefined();
    expect(got?.size).toBe(5);
    const bytes = new Uint8Array(await got!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("put overwrites an existing key", async () => {
    const a = new Blob([new Uint8Array([1])]);
    const b = new Blob([new Uint8Array([2, 2, 2])]);
    await putFragBlob("k", a);
    await putFragBlob("k", b);
    const got = await getFragBlob("k");
    expect(got?.size).toBe(3);
    const bytes = new Uint8Array(await got!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([2, 2, 2]);
  });

  it("get returns undefined for unknown key", async () => {
    expect(await getFragBlob("missing")).toBeNull();
  });

  it("delete removes the row", async () => {
    await putFragBlob("k", new Blob([new Uint8Array([9])]));
    await deleteFragBlob("k");
    expect(await getFragBlob("k")).toBeNull();
  });
});
