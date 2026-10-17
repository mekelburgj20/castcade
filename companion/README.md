# companion/

**Status: not started — Phase 2 (shell + Witness basic mode), then Phases 3–4.**

The Castcade desktop app for Windows: Electron + TypeScript. It is also the Windows desktop producer
for Arcaid Witness (ADR 0003), and its first shippable release is exactly that: install, pair, play,
and last-game VPX scores reach ArcAid with the Witnessed badge, before any netplay exists.

## Modules

| Module | Responsibility | Phase |
|---|---|---|
| `patcher` | *Import a table*: extract the script, classify, apply a recipe, write the sidecar (or copy), hash manifest, verification run, per-table registry with two states (*witnessed* / *ready for Castcade*); the setup wizard's forced-choice core.vbs bulk patch + contextual nudge; the arcade twin (import a ROM → memory map → test read). ADR 0004 | 3 |
| `witness` | Pair as a witness device (`/api/me/witness/pairing-code` → `/api/witness/pair`); process-watch `VPinballX*.exe -Play`; basic mode decodes `.nv` + `VPReg.stg` on exit with the bundled `pinmame-nvram-maps` corpus; live mode tails the journal; posts report / checkin / heartbeat / score to the existing ArcAid endpoints | 2–3 |
| `match` | Throwdown pickup by code; host mode (turn arbiter, append-only log, `HOST_TRANSFER`); client mode; script-side turn lock + "not your turn" overlay; `HELLO` hashing; ball-end detector as a pure function over journal events, replayable from `fixtures/` | 3 |
| `media` | VPX window capture + hardware encode (720p30), WebRTC video forwarded through the host, Opus voice mesh with push-to-talk for the active player, DMD + `STATE` overlay, upload test and host recommendation, STUN + optional TURN | 4 |
| `launch` | Locate and launch VPX and RetroArch, preflight hashes, core/ROM allowlist checks (`arcade/`) | 2, 6 |

## Packaging (non-negotiable, from the ArcAid Witness plan)

- Per-user install, no admin, no COM registration, no firewall prompt (IPC with the script is a
  journal file, not a socket).
- Default install modifies nothing in the player's VPX. Writes happen only after *Import a table*
  or the wizard's explicit choice, always with a hash manifest and one-click revert.
- Installer: Velopack (built-in delta auto-update) or Inno Setup; decide at Phase 2.
- **A code-signing certificate (OV/EV, roughly $200–400/yr plus reputation) is a launch blocker.**
  Unsigned downloads hit SmartScreen and most players stop there. Budget before Phase 2 ships
  outside the test group.
- Bundle the maps corpus with background refresh; ODbL attribution in the About box.
- Tray shows proof of life ("Last capture: … · Live mode on · N tables ready").

## What does not live here

- The message schemas (`protocol/`), the VBScript library and recipes (`vpx-hook/`), the RetroArch
  profiles and ROM maps (`arcade/`), recorded journals (`fixtures/`).
- The AtGames cabinet Witness app or any ArcAid server code (both stay in the ArcAid repo).

## Read first

`docs/design/arcaid-integration-gap-analysis.md`, `docs/design/table-import-and-patching.md`,
ADRs 0001–0004, and `ArcAid/docs/vpx-desktop-witness-plan.md` §4 and §8.
