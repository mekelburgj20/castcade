# castcade

**Cast your arcade.** Live remote multiplayer and spectating for virtual pinball and arcade emulators.

Two to four friends take turns on the same Visual Pinball X table (or the same arcade ROM in RetroArch)
from their own PCs, watch the active player live, and talk. One player's PC hosts the match; **ArcAid**
(arcaid.app) introduces the players and records the result as a Throwdown. Castcade also serves as the
Windows desktop producer for **Arcaid Witness**, reporting live VPX scores to ArcAid.

## Status

Design complete; **Phase 0 spike run on the owner's rig 2026-10-17: all five gates passed** (sidecar auto-load,
live NVRAM on WPC + Data East, script-side scoring on an original, script turn lock confirmed by hand, 720p30
capture). Results, findings and the first fixtures: [`docs/phase-0-spike.md`](docs/phase-0-spike.md) §8.
**Phase 1 (protocol + host mode) gate passed 2026-10-18:** protocol v1 with a generated
[`SPEC.md`](protocol/SPEC.md), the match engine in `companion/src/match`, and `fakeclient/`, whose gate test
(four players, three balls, one host transfer, identical signed logs) runs green in GitHub Actions. Start with
[`docs/design/arcaid-integration-gap-analysis.md`](docs/design/arcaid-integration-gap-analysis.md),
then the ADRs in [`docs/decisions/`](docs/decisions/). The phased roadmap with gates is in §6 of the gap analysis.

## How it works, in one breath

Import a table → Castcade patches a copy of its script so the game reports scores, ball ends and a turn lock
through a journal file → the host's companion grants turns, mirrors the active player's video and DMD to
everyone else over WebRTC, and keeps a signed match log → every participant signs the result → ArcAid stores it.

## Layout

`protocol/` message schemas · `companion/` the Electron app · `vpx-hook/` the injected VBScript · `fakeclient/`
CI player · `arcade/` RetroArch profiles and ROM maps · `fixtures/` recorded journals · `docs/` design + ADRs.

## License

GPLv3. Castcade never bundles Visual Pinball, VPinMAME, RetroArch, FBNeo, ROMs or table files; it finds the
copies you already have, hashes them, and launches them.
