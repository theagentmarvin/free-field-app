// Writes a small synthetic FreeField bundle for manual smoke tests.
//   pnpm exec tsx scripts/make-synthetic-bundle.ts [outFile] [rotationDeg]
import { writeFileSync } from "node:fs";

import { buildSyntheticBundle } from "../__tests__/bundle/fixtures/syntheticBundle";

const out = process.argv[2] ?? "synthetic.ffbundle";
const deg = Number(process.argv[3] ?? 25);
const { bytes } = await buildSyntheticBundle({ rotationRad: (deg * Math.PI) / 180 });
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes, plan rotated ${deg} deg)`);
