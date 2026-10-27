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
(four players, three balls, one host transfer, identical signed logs) runs green in GitHub Actions.
**Phase 2 (Arcaid Witness basic mode, v0.2.0) built 2026-10-18:** a tray app that pairs with ArcAid and posts the
last game's score when VPX exits, shipped as an unsigned per-user installer for the test group
([tester guide](docs/phase-2-witness.md), [tester kit](docs/tester-kit.md)). **Phase 3 first half (live mode,
v0.2.11, 2026-10-23):** Settings → Import tables → **Patch my tables** gives every ROM table in the folder a sidecar
script (the `.vpx` is never changed), after which every game posts its own score the moment it ends, not one
score when the table closes; Castcade says so when a table opens unpatched. v0.2.12 also reports the difficulty,
slope and nudge settings VPX had in force during the game, so Sanctioned play catches a mid-game tweak-menu change. v0.2.17 patches only machines whose live score it can read (84 of
the owner's 140 tables); the rest post their last game when the table closes. **End-to-end verified 2026-10-18 (v0.2.2):** a Monster Bash game played
in VR landed on an arcaid.app tournament board with the Witness badge. The clean-machine install check is pending. Start with
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
