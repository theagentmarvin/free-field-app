import { describe, expect, it } from "vitest";
import { calibrationDocId } from "@ff/firestore";
import { UNCALIBRATED_CALIB_ID } from "@ff/types";
import { canonicalCalibId, resolveCalibration } from "../src/calibResolve";

const row = (id: string, storeyName: string, pdfFileId = "pdf1") => ({ id, storeyName, pdfFileId });

describe("canonicalCalibId", () => {
  it("equals calibrationDocId", () => {
    expect(canonicalCalibId("p", "A/B")).toBe(calibrationDocId("p", "A/B"));
  });
});

describe("resolveCalibration", () => {
  const rows = [row("u1", "Level 1"), row("u2", "Level 2"), row("u3", "Level 1", "pdf2")];

  it("a. matches a legacy local id", () => {
    expect(resolveCalibration({ calibId: "u2", pdfFileId: "pdf1" }, rows)?.id).toBe("u2");
  });

  it("b. decodes the canonical doc id", () => {
    const calibId = calibrationDocId("pdf1", "Level 2");
    expect(resolveCalibration({ calibId, pdfFileId: "pdf1" }, rows)?.id).toBe("u2");
  });

  it("b. scopes by pdfFileId", () => {
    const calibId = calibrationDocId("pdf2", "Level 1");
    expect(resolveCalibration({ calibId, pdfFileId: "pdf2" }, rows)?.id).toBe("u3");
  });

  it("c. accepts the raw (unencoded) form", () => {
    expect(resolveCalibration({ calibId: "pdf1__Level 2", pdfFileId: "pdf1" }, rows)?.id).toBe("u2");
  });

  it("d. falls back to the pin's pdfFileId + storeyName", () => {
    expect(resolveCalibration({ calibId: "stale-uuid", pdfFileId: "pdf1", storeyName: "Level 2" }, rows)?.id).toBe("u2");
  });

  it("returns null with no match and no storey", () => {
    expect(resolveCalibration({ calibId: "nope", pdfFileId: "pdf1" }, rows)).toBeNull();
    expect(resolveCalibration({ calibId: "pdf1__Missing", pdfFileId: "pdf1", storeyName: null }, rows)).toBeNull();
  });

  it("never resolves the uncalibrated sentinel", () => {
    expect(resolveCalibration({ calibId: UNCALIBRATED_CALIB_ID, pdfFileId: "pdf1", storeyName: "Level 1" }, rows)).toBeNull();
  });

  it("rows without pdfFileId are assumed to belong to the pin's pdf", () => {
    const r = [{ id: "x", storeyName: "L" }];
    expect(resolveCalibration({ calibId: calibrationDocId("pdf1", "L"), pdfFileId: "pdf1" }, r)?.id).toBe("x");
  });

  describe.each(["Level 1", "Ground floor / lobby", "100% rated", "A%20B", "Etage Über-Grün", "地下1階", "a__b", "50%"])(
    "storey %j",
    (storey) => {
      const r = [row("local", storey), row("other", "zzz")];
      it("encoded doc id resolves (b)", () => {
        expect(resolveCalibration({ calibId: calibrationDocId("pdf1", storey), pdfFileId: "pdf1" }, r)?.id).toBe("local");
      });
      it("raw form resolves (c)", () => {
        expect(resolveCalibration({ calibId: `pdf1__${storey}`, pdfFileId: "pdf1" }, r)?.id).toBe("local");
      });
    }
  );
});
