import { describe, expect, it } from "vitest";

import { shouldUseLowMemoryTuning } from "@shell/lowMemoryDetect";

const desktop = { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", platform: "Win32", maxTouchPoints: 0 };

describe("shouldUseLowMemoryTuning", () => {
  it("is off for desktops and for browsers that expose no signal", () => {
    expect(shouldUseLowMemoryTuning(desktop, null)).toBe(false);
    expect(shouldUseLowMemoryTuning({ ...desktop, deviceMemory: 8 }, null)).toBe(false);
    expect(shouldUseLowMemoryTuning(undefined, null)).toBe(false);
  });
  it("is on for deviceMemory <= 4", () => {
    expect(shouldUseLowMemoryTuning({ ...desktop, deviceMemory: 4 }, null)).toBe(true);
    expect(shouldUseLowMemoryTuning({ ...desktop, deviceMemory: 2 }, null)).toBe(true);
  });
  it("is on for iPhone and iPadOS (Mac platform with touch)", () => {
    expect(shouldUseLowMemoryTuning({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }, null)).toBe(true);
    expect(shouldUseLowMemoryTuning({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }, null)).toBe(true);
    expect(shouldUseLowMemoryTuning({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }, null)).toBe(false);
  });
  it("honours the QA override both ways", () => {
    expect(shouldUseLowMemoryTuning(desktop, "1")).toBe(true);
    expect(shouldUseLowMemoryTuning({ ...desktop, deviceMemory: 2 }, "0")).toBe(false);
  });
});
