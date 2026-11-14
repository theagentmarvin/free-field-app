// __tests__/db/hash.test.ts
//
// Hash contract:
//   computeContentHash(file) === SHA-256( first 64KB(file) || 8-byte-BE(file.size) )
//
// We pin a few known hashes so any change to the prefix-length, size
// encoding, or endianness is caught immediately.

import { describe, expect, it } from "vitest";
import { computeContentHash } from "@ff/data/db/files/hash";

class FakeFile extends Blob implements File {
  readonly name: string;
  readonly lastModified: number;
  readonly size: number;
  readonly webkitRelativePath: string = "";
  // File constructor is not callable in all environments, so we build
  // a minimal stand-in. The hash helper only touches `size` and
  // `slice()/arrayBuffer()`, both of which Blob provides.
  constructor(parts: BlobPart[], name: string, sizeOverride?: number) {
    super(parts);
    this.name = name;
    this.lastModified = 0;
    this.size = sizeOverride ?? super.size;
  }
}

describe("computeContentHash", () => {
  it("hashes (head + 8-byte-BE size) for a tiny file", async () => {
    // head = [0x01, 0x02, 0x03], size = 3
    // expected: SHA-256(0102030000000000000003) = b49139aedc7be011e5599d410d99a9d678a4d846d1073ac1495826a354c44410
    const f = new FakeFile([new Uint8Array([1, 2, 3])], "a.ifc");
    expect(await computeContentHash(f)).toBe(
      "b49139aedc7be011e5599d410d99a9d678a4d846d1073ac1495826a354c44410",
    );
  });

  it("hashes an empty file (head=∅, size=0)", async () => {
    // expected: SHA-256(0000000000000000) = af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc
    const f = new FakeFile([], "empty.ifc", 0);
    expect(await computeContentHash(f)).toBe(
      "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
    );
  });

  it("truncates to first 64KB for larger inputs", async () => {
    // Build a 64KiB file of zeros, with a 1-byte non-zero tail beyond 64KB.
    // The hash should depend ONLY on the first 64KB (all zeros) and the
    // size — the tail must not affect the digest.
    const zeros = new Uint8Array(64 * 1024);
    const f = new FakeFile([zeros, new Uint8Array([0x42])], "big.ifc", 64 * 1024 + 1);
    expect(f.size).toBe(64 * 1024 + 1);
    // Assert the documented property: same prefix + same size = same hash.
    const a = await computeContentHash(
      new FakeFile([zeros, new Uint8Array([0xff])], "x.ifc", 64 * 1024 + 1),
    );
    const b = await computeContentHash(
      new FakeFile([zeros, new Uint8Array([0x00])], "y.ifc", 64 * 1024 + 1),
    );
    expect(a).toBe(b);

    // Also assert a known 64KB-zeros + size 65536 hash pin.
    //   65536 BE = 0x00 0x00 0x00 0x00 0x00 0x01 0x00 0x00
    const f64 = new FakeFile([zeros], "z.ifc", 65536);
    expect(await computeContentHash(f64)).toBe(
      "caccea24d5a09a533f77bbba7f4e3e007247ff4dc2db1ec2fd7fe07329cdc359",
    );
  });

  it("different size → different hash", async () => {
    const f1 = new FakeFile([new Uint8Array([1, 2, 3])], "a.ifc", 3);
    const f2 = new FakeFile([new Uint8Array([1, 2, 3, 4])], "a.ifc", 4);
    expect(await computeContentHash(f1)).not.toBe(await computeContentHash(f2));
  });
});
