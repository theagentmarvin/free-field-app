# Third-party notices

FreeField is MIT-licensed (see [LICENSE](LICENSE)). It redistributes the following third-party files in `apps/settings/public/`, under their own licenses:

| Files | Project | License |
|---|---|---|
| `web-ifc.wasm`, `web-ifc-node.wasm` | [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | MPL-2.0 (source code available at the project link) |
| `pdfjs/cmaps/*` | [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 |
| `pdfjs/standard_fonts/Foxit*.pfb` | Foxit fonts shipped with pdf.js | See `pdfjs/standard_fonts/LICENSE_FOXIT` |
| `pdfjs/standard_fonts/Liberation*.ttf` | Liberation fonts shipped with pdf.js | SIL Open Font License 1.1, see `pdfjs/standard_fonts/LICENSE_LIBERATION` |

npm dependencies (React, three.js, `@thatopen/components`, `@thatopen/fragments`, Dexie, Firebase SDK and others) are installed from the registry under their own licenses. `patches/` holds a small local patch to `@thatopen/fragments` (MIT).

## Demo data

`apps/settings/public/samples/sample.ifc` is a small sample structural model, provided for demonstration and as a test fixture.
