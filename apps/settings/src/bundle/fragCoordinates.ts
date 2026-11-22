// src/bundle/fragCoordinates.ts
//
// Read the coordinate shift (`getCoordinates()`) stored in a converted
// .frag. The importer converts with COORDINATE_TO_ORIGIN, so the shift
// is data dependent and only knowable from the produced fragment.

import * as FRAGS from "@thatopen/fragments";

import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { getIfcVersion } from "@ff/data/db/tables/ifcVersions";

import type { BaseShift } from "./bundleCalibration";

export async function readFragShift(fragBytes: Uint8Array): Promise<BaseShift> {
  const model = new FRAGS.SingleThreadedFragmentsModel("bundle-shift", fragBytes, true);
  try {
    await model.ready;
    const c = model.getCoordinates();
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  } finally {
    model.dispose();
  }
}

/** Shift of the stored fragment behind an IFC version. */
export async function readVersionShift(versionId: string): Promise<BaseShift> {
  const version = await getIfcVersion(versionId);
  if (!version) throw new Error(`IFC version not found: ${versionId}`);
  const blob = await getFragBlob(version.fragBlobKey);
  if (!blob) throw new Error("Converted model data is missing");
  return readFragShift(new Uint8Array(await blob.arrayBuffer()));
}
