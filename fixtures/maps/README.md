# fixtures/maps/

A **subset** of the [Pinball Memory Maps](https://github.com/tomlogic/pinmame-nvram-maps) corpus
(formerly `pinmame-nvram-maps`) by Tom Collins, vendored so the companion's witness tests run with
nothing outside this repository: only the maps and platform files the recorded journals in
`fixtures/nvram/` need.

- Source: `https://github.com/tomlogic/pinmame-nvram-maps`
- Commit: `f16a0cc6c347370706bf1a3f2c7a77568b3f69e7` (the pin in `.github/workflows/ci.yml`; also in `VERSION`)
- Files are byte-identical to that commit except `index.json` and `romnames.json`, which are cut down to the ROMs below
  (`romnames.json` is what the companion falls back to for a table name when VPX gave it none).

| ROMs | Map | Platform |
|---|---|---|
| `mb_106`, `mb_106b` | `maps/williams/wpc/mb_106.map.json` | `platforms/williams-wpc-12K.json` |
| `mm_109`, `mm_109b`, `mm_109c` | `maps/williams/wpc/mm_109.map.json` | `platforms/williams-wpc-12K.json` |
| `tftc_104` … `tftc_400` | `maps/dataeast/version3/tftc_400.map.json` | `platforms/dataeast.json` |
| `afm_113`, `afm_113b` | `maps/williams/wpc/afm_113.map.json` (has an `adjustments` block; used by `adjustments.test.ts` with synthetic bytes, no recording) | `platforms/williams-wpc-12K.json` |

## Licence and attribution

The map files are made available under the
[Open Database License (ODbL) v1.0](http://opendatacommons.org/licenses/odbl/1.0/) (`LICENSE-ODbL.md`);
rights in their individual contents are licensed under the
[Database Contents License (DbCL) v1.0](http://opendatacommons.org/licenses/dbcl/1.0/) (`LICENSE-DbCL`).

*This program makes use of content from the Pinball Memory Maps project
(https://github.com/tomlogic/pinmame-nvram-maps).*

The full corpus the shipped companion bundles is **not** committed: `npm run fetch-maps -w companion`
fetches the pinned commit into `companion/resources/maps/` (gitignored) and writes the same `VERSION`
file, which the app reports as `mapsVersion` and shows with this attribution in About.

Do not edit the vendored files; to move the pin, re-run the vendoring from the new commit and update
`VERSION`, this README, `fixtures/README.md` and `ci.yml` together.
