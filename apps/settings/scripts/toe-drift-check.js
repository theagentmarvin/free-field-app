#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const RULES = [
  {
    id: 1,
    pattern: /import\s+{[^}]*}\s+from\s+['"]three['"]/g,
    description: 'Named imports from Three.js detected. Prefer namespace import `import * as THREE`.',
    suggestion: 'Use `import * as THREE from \'three\'` for Three.js utilities, and `import * as OBC from \'@thatopen/components\'` for TOE components.'
  },
  {
    id: 2,
    pattern: /new\s+THREE\.(BoxGeometry|SphereGeometry|PlaneGeometry|Mesh|Material|Line|Points|Group|Object3D|Scene)/g,
    description: 'Manual geometry creation detected.',
    suggestion: 'Use TOE components like `OBC.Worlds`, `OBC.FragmentsManager` for geometry management.'
  },
  {
    id: 3,
    pattern: /\.add\s*\(\s*[a-zA-Z0-9_]+\s*\)/g,
    context: /scene\.add/,
    description: 'Direct scene.add() detected.',
    suggestion: 'Add components to a `World` via `world.scene.add()`.'
  },
  {
    id: 4,
    pattern: /new\s+THREE\.WebGLRenderer\s*\(/g,
    description: 'Raw WebGLRenderer creation detected.',
    suggestion: 'Use `OBC.PostproductionRenderer` or `OBC.SimpleRenderer`.'
  },
  {
    id: 5,
    pattern: /new\s+THREE\.(PerspectiveCamera|OrthographicCamera)\s*\(/g,
    description: 'Manual camera setup detected.',
    suggestion: 'Use `OBC.OrthoPerspectiveCamera`.'
  },
  {
    id: 6,
    pattern: /new\s+THREE\.OrbitControls\s*\(/g,
    description: 'Direct OrbitControls creation detected.',
    suggestion: 'Use `OBC.MouseNavigation` or built‑in camera controls.'
  },
  {
    id: 7,
    pattern: /new\s+IfcLoader\s*\(/g,
    description: 'Manual IFC loading detected (raw three‑ifc).',
    suggestion: 'Use `OBC.IfcLoader`.'
  },
  {
    id: 8,
    pattern: /new\s+THREE\.Raycaster\s*\(/g,
    description: 'Raw raycaster creation detected.',
    suggestion: 'Use `OBC.Raycasters`.'
  },
  {
    id: 9,
    pattern: /new\s+THREE\.Box3\s*\(\)\.setFromObject/g,
    description: 'Manual bounding box computation detected.',
    suggestion: 'Use `OBC.BoundingBoxer`.'
  },
  {
    id: 10,
    pattern: /\.dispose\s*\(\s*\)/g,
    context: /(geometry|material|texture)\.dispose/,
    description: 'Direct dispose calls detected.',
    suggestion: 'Use `component.dispose()` or `world.dispose()` for cleanup.'
  },
  {
    // 2026-06-01: FragmentsManager migration. Raw FragmentsModels
    // skips the camera-controls->update wiring and the polygon-
    // offset material setup that FragmentsManager does for you.
    id: 11,
    pattern: /new\s+FRAGS\.FragmentsModels\s*\(/g,
    description: 'Raw `new FRAGS.FragmentsModels(...)` detected. Prefer `OBC.FragmentsManager`.',
    suggestion: 'Use `const fragments = components.get(OBC.FragmentsManager); fragments.init(workerUrl);` and access models via `fragments.core.X`. The manager wires camera-controls + material setup automatically. (See MEMORY.md TOE FragmentsManager Pattern Library 2026-06-01.)'
  },
  {
    // 2026-06-01: Cloudflare's email-obfuscation rewrites
    // `fragments@3.4.5` and `web-ifc@0.0.77` to `[email protected]`
    // when served from unpkg. Use %40 instead.
    id: 12,
    pattern: /['"](https?:\/\/[^'"]*unpkg\.com\/[^'"]*@(?:thatopen|web-ifc))/g,
    description: 'unpkg URL with literal `@` in npm version pin detected. Cloudflare email-obfuscation will rewrite it to `[email protected]`.',
    suggestion: 'URL-encode the `@` as `%40` (e.g. `https://unpkg.com/%40thatopen/fragments%403.4.5/...`). Works around the rewrite. jsdelivr is currently broken for these paths; use unpkg with %40.'
  },
  {
    // 2026-06-01: without `raw: true`, IfcImporter.process() returns
    // pako-compressed bytes, and the worker throws "Malformed
    // fragments data!" on load. Both calls need the option.
    // We use a function-pattern (custom matcher) so we can scan the
    // 300 chars after the load( call for `raw: true` and skip
    // matches that already have it.
    id: 13,
    pattern: /fragments(?:Models)?\.(?:core\.)?load\s*\(/g,
    customMatch: (content, match) => {
      // Look 300 chars after the opening paren for `raw: true`.
      // This catches the common multi-line pattern where options
      // are spread across several lines.
      const after = content.substring(match.index, match.index + 300);
      return !/raw\s*:\s*true/.test(after);
    },
    description: 'FragmentsModels.load() called without explicit `raw: true`.',
    suggestion: 'Pass `raw: true` in the options object: `{ modelId, camera, raw: true }`. Without it, the bytes from `IfcImporter.process({ bytes, raw: true })` are misinterpreted as pako-compressed and the worker throws "Malformed fragments data!". (See MEMORY.md 2026-06-01.)'
  },
  {
    // 2026-11-05 (Wave 25): the batched id pass reaches FastModelPicker
    // privates (`_renderTarget`, `applyIdMaterial`, `readPixelAt`, …) that
    // are `private` in @thatopen/components@3.4.6. They must be reached
    // ONLY through the sanctioned `as any` adapter `src/picking/idPassInterop.ts`.
    // Any 3.4.x bump can silently rename these fields and turn picks into
    // permanent misses — confining the hazard to one boundary makes the
    // upgrade blast radius one file instead of every pick-path consumer.
    id: 14,
    pattern: /\.\s*(_renderTarget|_renderTargetSize|_idMaterial|applyIdMaterial|restoreOriginalMaterials|runIdPass|renderIdPass|renderPickPass|readPixelAt|setupRenderTarget|renderDepthPass|renderWithTileMaterial|buildIdMaterial)\b/g,
    description: 'Private @thatopen/components FastModelPicker id-pass internals referenced outside the sanctioned TOE-interop boundary.',
    suggestion: 'Route all FastModelPicker private-member access through src/picking/idPassInterop.ts (the single `as any` seam).',
    boundaryFile: /picking[\/]idPassInterop\.ts$/
  }
];

function lintFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const warnings = [];

  RULES.forEach(rule => {
    // Boundary-file skip (rule 14): the TOE-interop adapter is the one
    // place that MAY reference FastModelPicker private internals.
    if (rule.boundaryFile && rule.boundaryFile.test(filePath)) return;
    const regex = rule.pattern;
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Check context if specified
      if (rule.context && !rule.context.test(match[0])) continue;
      // Custom matcher (rule 13): only fire if raw: true is missing
      // within the next 300 chars (the typical options-object window).
      if (rule.customMatch && !rule.customMatch(content, match)) continue;
      
      // Find line number
      const upToMatch = content.substring(0, match.index);
      const lineNumber = upToMatch.split('\n').length;
      const lineText = lines[lineNumber - 1]?.trim() || '';
      // 2026-11-04: per-line exemption pragma — for rare, reviewed
      // cases where no TOE component exists (e.g. PDF overlay canvas
      // quads). Must carry a reason comment; reviewers police it.
      if (lineText.includes('toe-drift:allow')) continue;
      
      warnings.push({
        ruleId: rule.id,
        description: rule.description,
        line: lineNumber,
        match: match[0],
        suggestion: rule.suggestion
      });
    }
  });

  return warnings;
}

function formatMarkdown(warnings, filePath) {
  if (warnings.length === 0) return '';
  
  let output = `## Drift check\n\n`;
  warnings.forEach(w => {
    output += `⚠️ **Rule ${w.ruleId}**: ${w.description}\n`;
    output += `   Line ${w.line}: \`${w.match}\`\n`;
    output += `   → ${w.suggestion}\n\n`;
  });
  output += `*Total violations: ${warnings.length}*\n`;
  return output;
}

function walkTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walkTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node toe-drift-check.js <file-or-dir>');
    process.exit(1);
  }
  const stat = fs.statSync(input);
  const files = stat.isDirectory() ? walkTsFiles(input) : [input];
  if (files.length === 0) {
    console.log('No .ts/.tsx files found.');
    return;
  }
  let totalWarnings = 0;
  for (const f of files) {
    const warnings = lintFile(f);
    const markdown = formatMarkdown(warnings, f);
    if (markdown) {
      console.log(markdown);
      totalWarnings += warnings.length;
    } else {
      console.log(`✅ ${f}: no drift violations found.`);
    }
  }
  if (totalWarnings > 0) {
    console.log(`
❯ Total: ${totalWarnings} drift violation(s) across ${files.length} file(s).`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

