# Playfield tag census (B4.1)

`tags.json` pins the BIFF record tags the playfield fingerprint reads (`companion/src/witness/playfield-fingerprint.ts`,
`PLAYFIELD_TYPES` and `TABLE_FIELDS`) against a census of a real table saved by the current VPX. It holds record tag
names (four-letter identifiers such as `CLDW`) and counts only: no table data, no geometry, no scripts.

- Recorded from: Medieval Madness (Williams 1997) VPW v1.0.1, .vpx file version 1080 (VPX 10.8.0), on 2026-10-29.
- Types with no items in that table (their tags are not checked): spinner, rubber.
- `pinned` is the sorted tag list the fingerprint relies on; `census` is every tag the table contains.

Re-record after a VPX update (the table must be saved by the new VPX):

    npm run playfield-tags -w companion -- "<path to a .vpx>"

What a failing test means: the list-equality test fails when `PLAYFIELD_TYPES` or `TABLE_FIELDS` changed, so update the
fixture deliberately (and bump `PLAYFIELD_FINGERPRINT_VERSION` if hashes change). The census test fails when a tag we
read is absent from a table VPX saved: VPX renamed it or our list has a wrong tag, and every fingerprint would silently
change (a blessed Sanctioned fingerprint would stop matching).
