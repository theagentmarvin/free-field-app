// __tests__/ifc/convertIfc.test.ts
//
// Single-pass IFC conversion (wave 61), against the REAL web-ifc +
// IfcImporter and the sample IFC the settings app ships:
//   - metadata extracted from the importer's own parse equals the
//     standalone parseIfc() result;
//   - the .frag is byte-identical to the legacy pipeline output
//     (parseOnce=false importer, same options, pinned model guid);
//   - the OpenModel hook is scoped to the conversion and keyed per
//     input (concurrent conversions both stay single-pass);
//   - if the walk fails on the importer's model we fall back to a
//     standalone parse (correct result, singlePass=false).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as WEBIFC from "web-ifc";
import * as FRAGS from "@thatopen/fragments";

import * as metadata from "../../src/ifc/ifcMetadata";
import {
  convertIfc,
  PIPELINE_IFC_IMPORT_OPTIONS,
  __isOpenModelHookInstalled,
} from "../../src/ifc/convertIfc";
import { setFragmentsWasmPath } from "../../src/ifc/webIfcWasm";

const SAMPLE = new Uint8Array(
  readFileSync(resolve(__dirname, "../../../../apps/settings/public/samples/sample.ifc")),
);
const GUID = "00000000-0000-4000-8000-000000000000";

let failNextWalk = false;
vi.mock("../../src/ifc/ifcMetadata", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/ifc/ifcMetadata")>();
  return {
    ...orig,
    extractIfcMetadata: (ifc: WEBIFC.IfcAPI, id: number) => {
      if (failNextWalk) {
        failNextWalk = false;
        throw new Error("walk failed");
      }
      return orig.extractIfcMetadata(ifc, id);
    },
  };
});

async function legacyFrag(bytes: Uint8Array, all: boolean): Promise<Uint8Array> {
  const importer = new FRAGS.IfcImporter();
  setFragmentsWasmPath(importer);
  if (all) {
    importer.addAllAttributes();
    importer.addAllRelations();
  }
  return importer.process({ bytes, raw: true, id: GUID });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

afterEach(() => {
  failNextWalk = false;
});

describe("convertIfc (single pass)", () => {
  it("one web-ifc parse yields the legacy .frag bytes and the parseIfc metadata", async () => {
    const opens = vi.spyOn(WEBIFC.IfcAPI.prototype, "OpenModel");
    const progress: number[] = [];
    const res = await convertIfc(
      SAMPLE,
      { includeAllAttributesAndRelations: true, modelGuid: GUID },
      (p) => progress.push(p.fraction),
    );
    const openCalls = opens.mock.calls.length;
    opens.mockRestore();

    expect(res.singlePass).toBe(true);
    expect(openCalls).toBe(1); // was 3: parseIfc + importer geometry + importer properties

    const reference = await metadata.parseIfc(SAMPLE);
    expect(res.parsed).toEqual(reference);
    expect(res.parsed.storeys.length).toBeGreaterThan(0);
    expect(res.parsed.storeys.some((s) => s.containedElementIds.length > 0)).toBe(true);
    expect(res.parsed.propertyCatalog.some((e) => e.pset === "_IfcClass")).toBe(true);

    expect(equalBytes(res.fragBytes, await legacyFrag(SAMPLE, true))).toBe(true);

    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThan(1); // "done" is the job runner's
    expect(__isOpenModelHookInstalled()).toBe(false);
  });

  it("keeps the no-attributes option byte-identical too", async () => {
    const res = await convertIfc(SAMPLE, { includeAllAttributesAndRelations: false, modelGuid: GUID });
    expect(res.singlePass).toBe(true);
    expect(equalBytes(res.fragBytes, await legacyFrag(SAMPLE, false))).toBe(true);
  });

  it("the pipeline config (loadIfc AND replaceIfcVersion) is all attributes + relations, frozen", async () => {
    expect(PIPELINE_IFC_IMPORT_OPTIONS).toEqual({ includeAllAttributesAndRelations: true });
    expect(Object.isFrozen(PIPELINE_IFC_IMPORT_OPTIONS)).toBe(true);
    const res = await convertIfc(SAMPLE, { ...PIPELINE_IFC_IMPORT_OPTIONS, modelGuid: GUID });
    expect(equalBytes(res.fragBytes, await legacyFrag(SAMPLE, true))).toBe(true);
  });

  it("concurrent conversions each capture their own model", async () => {
    const other = SAMPLE.slice(); // distinct Uint8Array identity, same content
    const [a, b] = await Promise.all([
      convertIfc(SAMPLE, { includeAllAttributesAndRelations: true }),
      convertIfc(other, { includeAllAttributesAndRelations: false }),
    ]);
    expect(a.singlePass).toBe(true);
    expect(b.singlePass).toBe(true);
    expect(a.parsed).toEqual(b.parsed);
    expect(__isOpenModelHookInstalled()).toBe(false);
  });

  it("falls back to a standalone parse when the walk fails on the importer's model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failNextWalk = true;
    const res = await convertIfc(SAMPLE, { includeAllAttributesAndRelations: true });
    warn.mockRestore();
    expect(res.singlePass).toBe(false);
    expect(res.parsed).toEqual(await metadata.parseIfc(SAMPLE));
    expect(__isOpenModelHookInstalled()).toBe(false);
  });

  it("uninstalls the hook when the importer throws", async () => {
    const proc = vi
      .spyOn(FRAGS.IfcImporter.prototype, "process")
      .mockImplementation(async () => {
        expect(__isOpenModelHookInstalled()).toBe(true);
        throw new Error("importer failed");
      });
    await expect(
      convertIfc(SAMPLE, { includeAllAttributesAndRelations: true }),
    ).rejects.toThrow("importer failed");
    proc.mockRestore();
    expect(__isOpenModelHookInstalled()).toBe(false);
  });
});
