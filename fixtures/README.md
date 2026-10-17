# fixtures/

**Status: not started — populated from Phase 0 onward (first real journals), used by CI from Phase 2–3.**

Recorded evidence the detector and the patcher are tested against: NVRAM journals written by the
in-VPX hook, script-event logs from originals, and (later) RetroArch memory-read traces. The
handoff design proposed a `rommaps/` folder of hand-written RAM maps; that is replaced by the
`tomlogic/pinmame-nvram-maps` corpus as a dependency, and by **these recordings** as the test input.
Nothing here is authored by hand except the expected-outcome sidecar files.

## Layout and naming

```
fixtures/
  nvram/<rom>/<yyyy-mm-dd>-<n>.jsonl        journal lines from one VPX session on ROM <rom>
  nvram/<rom>/<yyyy-mm-dd>-<n>.expected.json  ball ends, player-up changes, game over, final scores
  script/<table-slug>/<yyyy-mm-dd>-<n>.jsonl  script-channel events from an original table
  arcade/<rom>/<yyyy-mm-dd>-<n>.jsonl         RetroArch memory-read traces (Phase 6)
  README.md
```

`<rom>` is the PinMAME ROM short name (`tftc_400`, `ij_l7`), never the table's display name.
`<n>` disambiguates several sessions on one day. The `.expected.json` is the oracle a CI run must
reproduce exactly.

## What a fixture must prove (Phase 3 gate)

100 ball ends across 5 tables, at least one an original, zero missed and zero false handoffs when
replayed through the detector in CI. Edge cases that need their own recording: ball save returning
the ball (no ball end), multiball draining to one ball (no ball end), tilt, extra ball (same
player stays up), a ball-1 restart, and the chaining guard with the bulk patch and a sidecar both
present.

## Rules

- **Never commit a ROM, a `.vpx` table file, a `.nv` file from someone else's machine, or a pairing
  token.** A journal is ours; a ROM or table is not.
- Record on the owner's rig or a consenting tester's, with the table and VPX version noted in a
  sibling `.meta.json`.
- Journals are append-only evidence; a bad recording is deleted and re-recorded, never edited.

## What does not live here

- The maps corpus (a dependency, bundled by the companion), the detector code (`companion/match`),
  the hook (`vpx-hook/`).

## Read first

`vpx-hook/README.md` (journal format), ADR 0001 §2 and §5, and the Phase 0 and Phase 3 rows of the
phases table in `docs/design/arcaid-integration-gap-analysis.md`.
