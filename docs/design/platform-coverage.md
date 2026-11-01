# Platform coverage: which ROM families live mode can read

Status: B10.2 / B10.3 design note, 2026-10-31. Companion code: `companion/src/witness/maps.ts`
(`liveSupport`, `ballyLiveInputs`, the System 3 mask), `companion/src/witness/journal-detector.ts`
(`detectTransition`, `samTransition`, `ballyTransition`). Counts are games per family from
`docs/witness-games.md` (2026-10-30); the orchestrator regenerates that list after this lands.

## The constraint

Live scoring of a VPM (ROM) table sees only what VPinMAME's `ChangedNVRAM` reports: the platform's
**NVRAM region** (`memory_layout` entry of type `nvram`, `docs/design/fairness-and-table-identity.md` §2 for
how a ROM is identified). CPU RAM is invisible to the in-table hook. The generic detector needs
`scores`, `game_over`, `current_ball` and `current_player` in that region (`LIVE_FIELDS`). A family whose
fields sit elsewhere needs its own NVRAM-only rule, or a producer that reads live memory, which on VPX 10.8.0
means the deferred VPX plugin (ADR 0001).

`liveSupport` is the single truth: the import patches only readable machines (B12), Status says why not, and
the published list counts on it. When a patched table's detector fires nothing, the companion still posts the
last game from the `.nv` at close, so **a wrong family detector costs the live post, never the score**.

"Supported (unverified)" below means `liveSupport` says readable, the rule is built from the map notes and
unit-tested on synthetic bytes, but no rig recording of the family exists in `fixtures/nvram/`. It becomes
"verified" when its fixture lands and replays in `journal-detector.test.ts`.

| Family | Games | Verdict | `via` |
|---|---|---|---|
| Bally AS-2518-35 (8K, 6K), AS-2518-17 (4K, 3K, 8K), Stern M100 | ~125 | detector built, **supported (unverified)** | `bally_lamp` |
| Gottlieb System 3 (Freddy's family) | — | already `game_state`; ball / player decode fixed (low-nibble mask) | `game_state` |
| Taito | 66 | already `game_state`; doubted (B14.1), needs a recording | `game_state` |
| Stern M200 | 44 | finding only | — |
| Williams System 4, 6, 7 | 78 | finding only | — |
| Gottlieb System 80 / 80B, System 1 | 24 | finding only | — |
| Atari gen 1 | 4 | finding only | — |
| Zaccaria gen 1 / gen 2 | 11 | finding only | — |
| Capcom | 4 | finding only | — |

## Bally AS-2518-17 / -35 and Stern M100 — detector built (`bally_lamp`)

**Where the fields sit.** One MPU lineage, one layout: NVRAM is the 5101 at 0x200–0x2FF (256 nibbles,
data in the high nibble, little-endian). Verified from the maps (eballdlx, the 13-ROM M100 `generic`, every
`as-2518-17/-35` map):

- `scores` at 0x21E, 0x225, 0x22C, 0x233 (7 digits; 6 on M100 at 0x21E/0x224/…): "display memory, active in
  game". Inside NVRAM.
- `final_scores` at 0x248, 0x24F, 0x256, 0x25D (M100 0x23C…): "during attract, last game scores". Inside NVRAM.
- `game_over` on nearly every map: the backbox GAME OVER lamp, `bool` at 0x20C mask 0x4 inverted (Gold Ball
  0x200 mask 0x8). Inside NVRAM (the lamp matrix lives in the 5101).
- `current_ball`, `player_count`, `current_player` at 0x0B–0x15: the 6810 CPU RAM. Out of reach.

**The rule** (`ballyTransition`, no ball events):

1. *Start*: lamp off and every display at 0 (a new game shows `00` and blanks; a blank digit decodes as 0),
   reached from the lamp on or from a game's scores, in either write order.
2. *End*, with a game open: lamp on, `final_scores` equal the displays, one above 0, and different from the
   `final_scores` at the start; first true in that step. Scores = `final_scores`; players = final scores above 0.
3. *Quit*: a reset (lamp on) followed by a new start while a game is open is `game_abandoned` then `game_start`;
   leaving the table abandons at `table_exit` as everywhere. Displays at 0 with the lamp off all along (a
   blanked display) are **not** a restart.
4. Only `current_scores` is kept from the generic rules: their lamp-driven `game_start` would fire on every
   attract flicker.

**Flicker.** Attract lamp shows can flash GAME OVER. A flicker alone starts nothing: the start needs every
display at 0, and in attract the displays show the last game or the high score to date (the M100 and M200 maps
carry an `ignore_scores` lamp "lit while the high score is shown in the score displays"). The residual case, a
flicker while every display is blank, opens a false game; the real game then still ends on rule 2 with its own
scores (only its start time is early).

**What is verified vs. inferred.** Verified: the addresses, encodings and that they sit in NVRAM (maps), and
the rules on synthetic bytes. Inferred from the map notes only: that `final_scores` is written once per game at
game over (not per ball, as M200's note says of its own `final_scores`), that the displays still show the final
scores when the copy happens, and the lamp's behaviour. If `final_scores` were written at every ball end, rule 2
still holds (the lamp is off mid-game). If the displays switch to attract before the copy, rule 2 never fires
and the game posts at close.

**Qualifies only when** (`ballyLiveInputs`): the platform is `bally-17-*`, `bally-35-*` or `stern-m100`, the
map has a `bool` `game_over`, one `final_scores` entry per `scores` entry, and all of them inside NVRAM. Rapid
Fire (`rapidfir`, no lamp in the map) stays unsupported. `gameStateOffsets` already watches every `game_state`
key, so the lamp and the last-game scores are journaled with no change to the hook.

**Recording recipe (Bally AS-2518-35)**, owner's rig:

1. Table: *Eight Ball Deluxe (Bally 1981)*, ROM `eballdlx` (map `as-2518-35/eballdlx.map.json`). Import it
   with the companion so the hook journals (a research recording with every NVRAM byte, the watch list removed
   as for the SAM recordings in B10, is better still: the region is only 256 bytes).
2. Let it sit in attract for 30 s (lamp shows, high-score display), then play one 1-player game to game over;
   wait 10 s in attract.
3. One 2-player game to game over; wait 10 s.
4. Start a 1-player game and quit on ball 1 (exit the table).
5. Send `%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl` and `companion.log`, with the final scores read off
   the displays.
6. Lands as `fixtures/nvram/eballdlx/<date>-1.jsonl.gz` + `.meta.json` (`fixtures/README.md`; `"oracle":
   false`, the Python tailer has no rule for it), expected: game_start ×3, game_end ×2 with those scores,
   players 1 then 2, the third abandoned at exit, no ball_end.

**Recording recipe (Stern M100)**: the same five steps on *Stars (Stern 1978)*, ROM `stars` (M100 `generic`),
landing in `fixtures/nvram/stars/`. **(Bally AS-2518-17)**, optional, the same on *Eight Ball (Bally 1977)*,
ROM `eightbll` (`system-rom-20`), in `fixtures/nvram/eightbll/`.

## Gottlieb System 3 — readable, ball decode fixed

**Where the fields sit.** All of them in the 8 KB NVRAM at 0x0000: scores at 0x001…, ball at 0x0015 (or 0x0B
on some maps), player 0x200, player count and game over 0x201. Readable via `game_state`; nothing to build.

**Finding (2026-10-31, the owner's `.nv` files, not committed).** The `.nv` is 8238 bytes and the map offsets
decode sensibly, but the ball byte carries flags in its high nibble: Cue Ball Wizard's 0x15 held 0x70 and
Rescue 911's 0x90, which unmasked BCD reads as ball 70 / 90. `plausible()` rejects the whole state (correctly:
the Medieval Madness 0x55/0xAA boot pattern relies on it), so the detector kept no state and a whole game
posted only at close. The corpus knows the pattern on siblings (`teedoff` masks the ball 0x7F, `clas1812`
0x0F, every `current_player` 0x0F) but `freddy` and the maps based on it (`cueball`, `andretti`, …) do not.

**Rule.** On `gottlieb-system3` and `gottlieb-system3-32K`, `compileMap` gives `current_ball` and
`current_player` a default `mask 0x0F` when the descriptor has none (a ball or player number is 0–9). The corpus
files are not changed; a map's own mask wins (Tee'd Off keeps 0x7F). 0x70 → 0, 0x90 → 0, 0x83 → 3, 0x31 → 1.
This is probably the Freddy rung: high-nibble flags on that byte during play would silence every unmasked
System 3 map. Unverified until recorded.

**Recording recipe**, owner's rig (both tables have sidecars there):

1. *Cue Ball Wizard (Gottlieb 1992)*, ROM `cueball`: one 1-player game to game over.
2. *Tee'd Off (Gottlieb 1993)*, ROM `teedoff3`: one 1-player game to game over.
3. Send both journals and `companion.log`, with the final scores.
4. Lands as `fixtures/nvram/cueball/<date>-1.jsonl.gz` and `fixtures/nvram/teedoff3/<date>-1.jsonl.gz` +
   `.meta.json`; expected game_start, one ball_end per ball, game_end with the score. That makes the family
   verified.

## Taito — readable by the map, doubted (B14.1)

All four fields sit in the 256-byte NVRAM window at 0x4000 (scores 0x4080…, ball 0x408C, game over a lamp bit
at 0x409F), so `liveSupport` says `game_state` for 66 games. Nothing changes here. B14.1 doubts the claim and
no Taito journal exists yet, so it rests on the map alone. A rig recording must show, in the journal: `nvram_full` covering the window, `nvram_delta`
lines touching 0x80–0x9F during play, and the derived game_start, ball_end per ball and game_end with the
displayed score. If the deltas never touch those offsets, Taito is unsupported and `liveSupport` must say so.
Recipe: one 1-player game on any Taito table with a map (e.g. *Vortex*), sent and landed as above under
`fixtures/nvram/<rom>/`.

## Stern M200 — finding only (B10.3)

NVRAM is 0x200–0x2FF, but the map puts `scores` (display memory, 0x000…), the GAME OVER lamp (0x19 / 0x1F),
ball (0x31 / 0x37) and player in CPU RAM. In NVRAM: `final_scores` (0x280…, "only updated at end of each ball")
and `player_count` (0x2EE). So NVRAM shows a ball ending (when it scored) but neither a game start nor a game
end, and the ball count is a DIP switch. Not faked. Two ways in: a live-memory producer (the VPX plugin, ADR 0001,
reading the lamp at 0x1F and the ball at 0x37), or a research recording to test whether `player_count` or
another NVRAM byte resets at game start, which could pair with the per-ball `final_scores` and the `.nv`'s DIP
switches. The `.nv` at close still posts.

## Williams System 4, 6, 7 — finding only (B10.3)

NVRAM is 0x100–0x1FF (low nibble, the 5101 holding audits and settings). Scores (0x00 / 0x38…), ball (0x03 /
0x58), player and game over (a lamp at 0x0F–0xC9, an enum at 0x78 on System 6) are all in CPU RAM (0x000–0x0FF,
and 0x1000 on System 7). Nothing in NVRAM moves during a game except audits, so nothing NVRAM-only can follow it.
A live-memory producer needs reads of the CPU RAM at the map's addresses (the maps already describe them), i.e.
the VPX plugin per ADR 0001.

## Gottlieb System 80 / 80B and System 1 — finding only (B10.3)

NVRAM is the 256-nibble 5101 at 0x1800 (low nibble). Scores (System 80 0x00D2…, 80B 0x0000…, System 1 0x1010…),
ball, player and the game-over lamp sit in the RIOT / CPU RAM below it. Same verdict and the same producer
requirement as Williams System 4–7.

## Atari gen 1 — finding only (B10.3)

The platform has no NVRAM region (a size-0 placeholder at 0x1000); every field sits in the 0x000–0x1FF RAM.
Needs a live-memory producer.

## Zaccaria gen 1 / gen 2 — finding only

NVRAM 0x1800 (gen 1 0x400, gen 2 0x800, low nibble). The maps describe only `scores` (gen 2 0x1CC0, gen 1
0x1800) and `credits`, both inside NVRAM; there is no game over, ball, player or last-game record. Scores
alone give a start (all back to 0, as SAM) but no end. Stays unsupported. What would change it: a research
recording with every NVRAM byte journaled (one 1-player game to game over, one quit on ball 1, on *Devil Riders*
`dvlrider`) to look for a byte that changes once at game over, as SAM's counter did; a map contribution
upstream if one is found.

## Capcom — finding only

The maps carry no usable `game_state` (most have none; `bbb108` has descriptors without addresses). Nothing to
read until the corpus maps them.
