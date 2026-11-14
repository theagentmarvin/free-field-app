// packages/ff-data/src/hooks/index.ts
//
// React hooks subpath for @ff/data (@ff/data/hooks).
//
// These are the IFC/PDF pipeline hooks that were shared across
// modules (Models' Viewer, LinkView's split canvas, Documents'
// groups) and therefore had to leave apps/settings when the data
// core was extracted. They depend on the pure ./db layer + React +
// web-ifc/@thatopen/fragments (no @thatopen/components — so no
// three/webgpu load chain).
//
// Kept out of the root barrel so non-React consumers of @ff/data
// never pull React or web-ifc.

export * from "./useIfcPipeline";
export { ingestIfc, withImportLock, type IngestIfcOptions, type IngestTarget } from "../pipeline/ingestIfc";
export * from "./useIfcFiles";
export * from "./usePdfFolders";
