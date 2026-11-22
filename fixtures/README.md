# fixtures/

**Status: first three fixtures recorded 2026-10-17 (Phase 0, `docs/phase-0-spike.md` §8): `nvram/mm_109c`, `nvram/tftc_400`,
`script/iron-maiden-lotb`; a fourth, `nvram/mb_106b/2026-10-23-1` (hook 0.3.0, three table loads, five games: the C7
live-mode gate), recorded 2026-10-23; a fifth, `nvram/mm_109c/2026-10-25-1` (hook 0.4.0 on real VPX, two games, the
first `engine` line), recorded 2026-10-25; two Stern SAM sessions, `nvram/acd_170h/2026-10-25-1` and
`nvram/twd_160h/2026-10-26-1` (every NVRAM byte journaled, B10), recorded 2026-10-25/26; one Gottlieb System 3 session,
`nvram/cueball/2026-11-01-1` (hook 0.4.1, one game; the ball byte is cleared 3.5 s before game over, the finding behind
"System 3 posts at close"), recorded 2026-11-01; two Stern SAM sessions of Spider-Man Vault Edition,
`nvram/smanve_101/2026-11-05-1` (three table loads) and `nvram/smanve_101/2026-11-21-1` (the owner's side of a two-player
match in which no ball end reached the match: C18, "Stern SAM ball ends" below), watched bytes only.
Used by CI from Phase 2–3.** A fourth, hand-played MM session (2026-10-17, two games + one abandoned at
exit) is archived locally only, 18.7 MB gzipped is too large for git; see `docs/phase-0-spike.md` §8 "Owner's hands-on pass". Journals are written by the hook to
`%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl`; copy a session here under the names below. NVRAM journals are large
(the 0.1.0 hook writes every changed byte: 37 MB for two games of Medieval Madness) so they are stored **gzipped**
(`.jsonl.gz`, `gzip -9 -n`); the tailer reads both. Replay: `python vpx-hook/spike/tail-journal.py fixtures/nvram/mm_109c/2026-10-17-1.jsonl.gz`.

Recorded evidence the detector and the patcher are tested against: NVRAM journals written by the
in-VPX hook, script-event logs from originals, and (later) RetroArch memory-read traces. The
handoff design proposed a `rommaps/` folder of hand-written RAM maps; that is replaced by the
`tomlogic/pinmame-nvram-maps` corpus as a dependency, and by **these recordings** as the test input.
Nothing here is authored by hand except the expected-outcome sidecar files.

## Layout and naming

```
fixtures/
  nvram/<rom>/<yyyy-mm-dd>-<n>.jsonl[.gz]   journal lines from one VPX session on ROM <rom>
  nvram/<rom>/<yyyy-mm-dd>-<n>.meta.json      table file + hashes, VPX version, how it was played, expected outcome (prose)
  nvram/<rom>/<yyyy-mm-dd>-<n>.expected.json  ball ends, player-up changes, game over, final scores (machine-readable; Phase 3)
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

## CI check

Two replays run on every push. `companion/src/witness/journal-detector.test.ts` (vitest, `npm test`) feeds each fixture
through the companion's own detector and asserts the same counts as below plus the final scores. The Python oracle stays:
`python fixtures/check.py` replays every `*.jsonl[.gz]` that has a sibling `.meta.json` through
`vpx-hook/spike/tail-journal.py --quiet-scores` and asserts, from `meta.games` (and
`meta.balls_per_game`, default 3): `game_start == games`, `game_end == games`,
`ball_end == balls_per_game * games`, balls seen ending `== [1 .. balls_per_game]`. Recipe A fixtures
are judged on the detector's `derived:*` counts, script recipes on the raw script events. One
`PASS`/`FAIL` line per fixture, exit 1 on any failure. `CASTCADE_NVRAM_DIR` is pointed at an empty
temp dir so no on-disk `.nv` is consulted. The `fixtures` job in `.github/workflows/ci.yml` runs it on
every push and pull request against pinned clones of the corpus and parser:

| Dependency | Env var | Pinned commit |
|---|---|---|
| `tomlogic/pinmame-nvram-maps` | `CASTCADE_MAPS` | `f0c422099f0b50b69bfdf6d071a6653a8b25a6fd` |
| `tomlogic/py-pinmame-nvmaps` | `CASTCADE_NVPARSER` | `00ea7847545c9edd84613db99c7dd54976ddf568` |

Locally, point both variables at the clones under `C:\code\repos\ArcAid\tmp\vpx-desktop-witness\`.
A meta with `"oracle": false` is skipped there (Stern SAM: the tailer has no rules for it) and judged by the vitest
replay alone. A new fixture needs only its `.meta.json` with `games` (and `recipe`) set; bump the pins here and in
`ci.yml` together.

## Stern SAM ball ends: what is recorded, and what would have to be (C18)

Live mode follows a Stern SAM machine for its scores and its game end (`samEndCounter`) and derives **no ball end**:
the maps put the ball in play, the player up and game over in CPU RAM, which `ChangedNVRAM` never reports. So
`liveSupport().ballEnds` is false for every SAM map (and for Bally AS-2518-17/-35 and Stern M100, read by the lamp), the
witness reports it (`WitnessStatus.ballEnds`), and a match on such a table takes its turns by hand (Pass the turn).

`nvram/smanve_101/2026-11-21-1` is the night that showed it (match JTWURE, 2026-11-21 08:02 to 08:13 UTC). Between the
game's start and its end the journal holds 190 lines and every one is player 1's score; credits fall once at the start
and the end-of-game counter rises once at the end. The 5820 other bytes that changed in NVRAM were not on the watch list
and are not in the journal. A pause in the score cannot stand in for a ball end: that game has four pauses of 11 s or
longer during play (after t=92.6, 207.2, 239.9 and 664.6) for the two ball changes of a three-ball game, and every
session of this table has a +2,000,000 award followed by 8 to 13 s of silence.

What the two recordings that kept every NVRAM byte show (`acd_170h/2026-10-25-1`, `twd_160h/2026-10-26-1`, B10): each
ROM has one record in its audit area that goes up by one when a ball drains, 0.9 to 4.5 s before the bonus is added to
the score: 13 times over the four games of `acd_170h` (3, 3, 6 for the 2-player game, 1 for the game left after its
first drain) at NVRAM offset `0x26A8`, 9 times over the three games of `twd_160h` (3, 6, 0) at `0x27E0`. A record is 16
bytes: the value (u32, little-endian), 0, the value again, and 0xFFFFFFFF minus the byte sum of those twelve (the
end-of-game record has the same check word). `journal-detector.test.ts` ("evidence for a follow-up") replays this.

What is not known, and what to record to know it:

1. **The record's address on `smanve_101`.** The four table-load snapshots of the two `smanve_101` fixtures bracket
   three games; 19 audit records differ between them and one, at `0x2440`, reads 0, 3, 6, 8 (one finished three-ball
   game, then two games that were left). It is a candidate only: no journal shows when it changes. Record one session
   with every NVRAM byte journaled (the B10 way: remove the `Castcade_WatchBytes` line from the rendered sidecar, so
   `filtered_bytes` is 0) or with the 16 bytes at `0x2440` on the watch list: one player, three balls to game over, the
   drain times noted by hand.
2. **What else moves it.** In the same recording or a second one: a ball the ball saver returns (the count must not
   rise), an extra ball (does it rise at each drain; nothing in NVRAM says the same player shoots again), a tilt, a
   game left in the middle of a ball.
3. **Every other SAM ROM.** The address differs on the three ROMs looked at and no SAM map of the corpus has an
   `audits` block, so each ROM needs its own recording (or a map contribution upstream) before its ball ends are
   promised.

With that, the companion side is: the record's bytes on the watch list (`watchOffsets`; a recipe bump re-makes the
sidecars), a rule beside `samTransition` (the count up by one with a game open is a `ball_end`), and `ballEnds` true
for the ROMs whose record is known. The journal format does not change.

## What does not live here

- The maps corpus (a dependency, bundled by the companion), the detector code (`companion/match`),
  the hook (`vpx-hook/`).

## Read first

`vpx-hook/README.md` (journal format), ADR 0001 §2 and §5, and the Phase 0 and Phase 3 rows of the
phases table in `docs/design/arcaid-integration-gap-analysis.md`.

## `maps/` — vendored map subset for the companion tests

`fixtures/maps/` holds the `pinmame-nvram-maps` map files (plus their platform files, a cut-down
`index.json`, the ODbL/DbCL licences and a `VERSION` with the commit) that `companion/src/witness/maps.test.ts`
needs to decode the `mm_109c`, `tftc_400` and `mb_106b` journals above with the companion's own TypeScript interpreter.
The files are byte-identical to the pinned commit `f0c422099f0b50b69bfdf6d071a6653a8b25a6fd`; see
`fixtures/maps/README.md` for attribution. Ground truth for those tests (final scores, player count, ball,
game-over, high scores) was taken from the Python reference (`tail-journal.py` → `py-pinmame-nvmaps` at the
pinned commits) on 2026-10-18: MM `[1089510, 0, 0, 0]`, player_count 1, ball 3, game over; TFTC
`[2318430, 0, 0, 0]`, player_count/player/ball 0 (Data East clears them at game over), game over.
Journal deltas are `[index, new, old]`; the first delta of each fixture precedes the first `nvram_full`
and is skipped, exactly as the tailer does.

## `vps/` — vendored VPS index subset for the table-identity tests

`fixtures/vps/index.json` is a 13-game cut of the compact index that `companion/scripts/fetch-vps.ts` builds from
the Virtual Pinball Spreadsheet database (`VirtualPinballSpreadsheet/vps-db`, `db/vpsdb.json`, community-maintained
metadata about games and table files; pinned commit in `VERSION`). The companion fetches the full index at build time
(`npm run fetch-vps -w companion`, ~1.4 MB, gitignored under `companion/resources/vps`); only this subset is committed,
for `vps-index.test.ts` and `table-match.test.ts`. The vps-db repo declares no licence, so both the fixture and the
built index keep nothing but identifiers and attribution: game id/name/manufacturer/year/type, ROM ids, and per table
file id/authors/version/features/format/comment/updatedAt (no download URLs, images or descriptions). The subset holds
the owner's three acceptance games (Monster Bash, Medieval Madness, Tales from the Crypt), the five games that share the
`rollstob` ROM, two same-name pairs (Deadpool 2014/2018, Black Belt Zaccaria/Bally 1986), and one game without ROMs
(Sittin' Pretty). Regenerate with
`npm run fetch-vps -w companion -- --from <vpsdb.json> --out fixtures/vps --subset <the ids in the file>`.
