// src/bcf/fragGuids.ts
//
// Read IFC GlobalIds for local ids straight from a stored .frag (used by
// the BCF export when the shared viewer does not have the model loaded).
// Same loading pattern as bundle/fragCoordinates.ts.

import * as FRAGS from "@thatopen/fragments";

import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { getIfcVersion } from "@ff/data/db/tables/ifcVersions";

export async function readFragGuids(fragBytes: Uint8Array, localIds: number[]): Promise<Array<string | null>> {
  const model = new FRAGS.SingleThreadedFragmentsModel("bcf-guids", fragBytes, true);
  try {
    await model.ready;
    return await model.getGuidsByLocalIds(localIds);
  } finally {
    model.dispose();
  }
}

/** GlobalIds for `localIds` of the stored fragment behind an IFC version. */
export async function readVersionGuids(versionId: string, localIds: number[]): Promise<Array<string | null>> {
  const version = await getIfcVersion(versionId);
  if (!version) throw new Error(`IFC version not found: ${versionId}`);
  const blob = await getFragBlob(version.fragBlobKey);
  if (!blob) throw new Error("Converted model data is missing");
  return readFragGuids(new Uint8Array(await blob.arrayBuffer()), localIds);
}
