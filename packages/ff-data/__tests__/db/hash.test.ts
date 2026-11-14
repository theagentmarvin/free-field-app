// __tests__/db/hash.test.ts — full-file hash used for IFC dedupe
// (wave 63 review item 5).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { computeContentHash, computeFullContentHash } from "../../src/db/files/hash";

describe("computeFullContentHash", () => {
  it("is SHA-256 over every byte", async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(await computeFullContentHash(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await computeFullContentHash(bytes.buffer)).toBe(await computeFullContentHash(bytes));
  });
  it("tells apart files the legacy head hash confuses (same size, same first 64 KB)", async () => {
    const a = new Uint8Array(100_000);
    const b = new Uint8Array(100_000);
    b[99_999] = 1;
    expect(await computeContentHash(new File([a], "a"))).toBe(await computeContentHash(new File([b], "b")));
    expect(await computeFullContentHash(a)).not.toBe(await computeFullContentHash(b));
  });
});
