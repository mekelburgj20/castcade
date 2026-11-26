# ADR 0012 — Another player's disconnect never disturbs the player who is up

**Status:** Accepted (2026-11-24)
**Owner rulings:** 2026-11-24, after a match night where the owner's own link dropped several times while Krobs played
on: "We never want another player's disconnect to cause the active player to have a messed up session."
**Builds on:** ADR 0002 (a match is a Throwdown), the peer-hosted architecture in `CLAUDE.md`. **Code:** WORK A18
(PR #126), the lobby A17 (PRs #127 to #144, `docs/design/alpha-match.md` §11).

## Context

Before A18 a dropped relay link of any player paused the match for everyone, rebuilt the voice and video connections,
and could leave the player who was up with a paused or locked table (match nights of 2026-11-23 and 2026-11-24: one
ArcAid deploy and three host-side closes; later the owner's own network adapter). The player who is up is the one
person whose experience cannot be paused without spoiling the game: their ball is live on their own PC.

## Decision

1. A link that drops is given a grace (5 s, `DEFAULT_DISCONNECT_GRACE_MS`) before anyone is told; within it nothing
   happens anywhere.
2. Only the player who holds the turn can pause their own game by being away. Anyone else who drops is marked AWAY;
   the game waits for them only at their own turn, and the lobby's PC can play on without them.
3. Media is never rebuilt for the player who is up because someone else dropped: their voice, picture and 3D
   connections with the others stay as long as those connections themselves are up.
4. A player who is up and out of reach but still seen playing (their picture or 3D still arrives) is never forfeited by
   a clock: the lobby's PC is asked whether to keep waiting, end their ball at the score as it stands, or play on.
5. The same holds when the arbitrating PC (the host, the lobby's PC) is the one away or restarting: the ball in play
   goes on, its end is kept and counted once when that PC is back.

## Consequences

### Easier
Testers on unreliable connections can play; a blip on a watcher's PC is invisible to the player.

### Harder
Every change to the match engine, the shell or media must be checked against this rule; the reviews of A17 and A18
each tested it explicitly (`match-host-lobby.test.ts`, `lobby-away.test.ts`, `lobby-restore.test.ts`).

### Locked out
A global pause on any disconnect; rebuilding all media on a reconnect; a turn clock that forfeits a player who is still
seen playing.

## Alternatives rejected

- **Pause everyone until the link is back** (the pre-A18 behaviour): fair on paper, spoils the live ball of the player
  who is up, and the owner ruled it out.
- **Forfeit by clock alone**: a player whose control link dropped but who is visibly playing would lose a ball they
  are in the middle of.
