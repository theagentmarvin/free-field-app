// __tests__/ifc/webIfcWasm.test.ts — web-ifc wasm comes from the app's
// own copy at BASE_URL, never a CDN (wave 63 review item 3).
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBrowserWasmDir } from "../../src/ifc/webIfcWasm";
import * as src from "../../src/ifc/webIfcWasm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getBrowserWasmDir", () => {
  it("anchors BASE_URL at the page origin (absolute, trailing slash)", () => {
    vi.stubGlobal("location", { href: "http://app.test/x/y", origin: "http://app.test" });
    expect(getBrowserWasmDir()).toBe("http://app.test/");
  });
  it("falls back to '/' without a location", () => {
    expect(getBrowserWasmDir()).toBe("/");
  });
  it("has no CDN constant any more", () => {
    expect(Object.keys(src)).not.toContain("WEBIFC_CDN");
  });
});
