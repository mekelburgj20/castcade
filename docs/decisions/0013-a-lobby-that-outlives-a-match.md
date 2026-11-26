# ADR 0013 — A lobby that outlives a match

**Status:** Accepted (2026-11-24); built as WORK A17 (PRs #127 to #140), unverified on two PCs
**Owner rulings:** 2026-11-23: "keep our audio session live, even between matches … 'join lobby'. Anyone in the lobby
can all chat. Then we start and end matches without leaving the lobby". 2026-11-24: "1. Anyone can start a match in the
lobby. 2. Yes, tables can change between matches without anyone leaving. This is ideal! 3. … anyone in it can watch in
VR spectator view, the actual player who is up - even though they are not playing themselves. So 5 people could be
watching a 1 v 1 match." Choices the same day: a watcher sees "3D if possible, else video"; "Each person picks Play or
Watch"; "Four first, bigger next".
**Builds on:** ADR 0002 (each match is its own Throwdown), ADR 0009 and 0011 (what a watcher sees), ADR 0012.
**Design:** `docs/design/alpha-match.md` §11 (PR #124).

## Context

Until 0.2.50 a code joined one match: voice, video and 3D connections were made at the join and torn down at its end,
so four matches in an evening meant four codes and four rounds of connection setup, and someone who was not playing
had no place.

## Decision

1. The Match tab opens or joins a **lobby**: one code an evening, up to four people (five or more later, A17.1).
   Voice, video and 3D connections are made once and kept across matches.
2. **Anyone in the lobby can start a match**; each person is set to **Play or Watch**, and a start takes those set to
   Play. A start counts down and anyone can cancel it.
3. **The table can change between matches** without anyone leaving; every PC follows, and Castcade never closes a
   table that might hold a game or one it cannot be sure about (it asks the person).
4. **Anyone can watch the player who is up**, the lobby's PC included, in 3D in their own VPX where both have the
   Castcade VPX build and the table, the 2D video otherwise.
5. Each match in the lobby is its own Throwdown (ADR 0002 unchanged). The lobby is protocol 7: everyone updates
   together (shipped as 0.2.51, owner 2026-11-25: "Do this in 0.2.51").
6. The lobby's PC arbitrates; handing a lobby to another PC is later (A17.2).

## Consequences

### Easier
An evening is one join; watchers are first-class; tables and matchups change without setup.

### Harder
A large state machine (the lobby, its matches, away members, restarts, table changes), held only by tests until a
two-PC evening; protocol 7 breaks compatibility with 0.2.46 to 0.2.50.

### Locked out
A match as the unit you join; a start only the host may make.

## Alternatives rejected

- **Keep the voice in a separate session from matches:** two codes and two sets of connections for one evening.
- **Only the host starts matches:** ruled out by the owner (ruling 1).
