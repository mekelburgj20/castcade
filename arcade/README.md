# arcade/

**Status: not started — Phase 6 (can start any time after Phase 1; needs no VPX).**

Castcade does not build arcade netplay; it drives RetroArch's. RetroArch netplay runs one emulated
machine every participant is connected to, the ROM itself alternates players, so there is no
detector, no video stream and no turn lock to build. Castcade's job is the lobby, the preflight,
the launch, the score read and the result. The *Import a ROM* flow mirrors *Import a table*
(ADR 0004): pick a ROM → hash → core allowlist check → memory map lookup → verification read →
registry entry.

## What lives here

- `profiles/` — RetroArch launch profiles: host (`--host`) and client (`--connect <host>`) command
  lines per core, player-slot mapping from the Throwdown's player order to joypad slots 1–4.
- `cores.json` — the core allowlist: **FBNeo first**, **MAME 2003-plus as fallback** for ROMs FBNeo
  lacks, **current MAME libretro core excluded** until its netplay is verified.
- `maps/<rom>.json` — per-ROM score and player-up memory addresses, seeded from RetroAchievements'
  published addresses for the same ROMs (ArcAid already imports the RetroAchievements catalogue,
  so each map can be keyed to an ArcAid catalogue game).
- `preflight.md` — what the companion hashes and refuses on mismatch: RetroArch version, core
  binary, ROM zip; the lobby names which PC differs.
- `poller.md` — the score read via RetroArch's UDP command interface. **Unverified:** the exact
  memory-read command name and address format in the current release, and whether it works while
  netplay is active on both host and client. First task of this phase.

## Constraints to build around (from the handoff design)

- Same RetroArch version, same core version, same ROM on every PC.
- Lockstep: one slow PC stutters everyone; the lobby warns when any participant's RTT to the host
  exceeds 120 ms.
- Four-player simultaneous games (beat-em-ups) skip the grant messages entirely.
- RetroArch, cores and ROMs are the player's own installs; nothing is downloaded or redistributed.

## Phase 6 gate

A 4-player Galaga match on real PCs with correct scores captured for all four. First ten target
ROMs: Galaga, Donkey Kong, Pac-Man, Ms. Pac-Man, Dig Dug, Frogger, Centipede, TMNT, The Simpsons,
Street Fighter II (FBNeo 4-client stability over 15 minutes is unverified).

## What does not live here

- The process launcher itself (companion `launch` module) or the voice mesh (companion `media`).
- Anything pinball.

## Read first

The "Arcade mode (RetroArch)" section of `docs/design/remote-two-player-design-handoff.md` and
ADR 0004 §1 (the import flow).
