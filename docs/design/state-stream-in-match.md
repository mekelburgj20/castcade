# The state stream inside a match (I11.3, I11.4.2)

Status: design, 2026-11-18. ADR 0011 is the ruling; `WORK.md` I11 is the tracker. Written after I11.2 passed
(owner + Krobs, both directions, 2026-11-18).

## 1. What changes for a player

In a match, while another player is up, a PC that has the Castcade VPX build and the identical table file shows
that player's game **on its own table, from its own head**, instead of the flat video on a screen. At its own
turn its own game is back exactly as it left it. A PC without the build, or with another table file, keeps the
2D video (ADR 0009), with nothing to set up. Voice, the scoreboard panel, the turn lock, scoring and the
witness do not change.

Today a VPX is a player or a watcher for as long as the table is open (`CASTCADE_STREAM=play|watch`, read once).
A match needs one VPX that is both, by turns. That is the whole of the new work in the fork (§2); the companion
side is the existing tunnel (I11.4.1) driven by the grant instead of by the 3D watch card (§4).

## 2. The fork: role `match` (I11.3)

`CASTCADE_STREAM=match` is a play session that can be sent to watch and called back.

**Playing** (the state at table load): exactly today's play role. It listens on `CASTCADE_STREAM_ADDR`
(`listen:127.0.0.1:<port>`), captures script calls from the script's first call, sends frames and keyframes.

**Entering watch** (`watch <host>:<port>` on the control connection, §3):

1. The local game stops the way VPX's own pause stops it: no physics steps, no script timers, no hit events,
   and the table's `Paused` event is fired so that a ROM table pauses VPinMAME as it does when the window
   loses the focus. Rendering does not stop (in VR a VPX that stops presenting frames freezes the headset), so
   this is not `Player`'s pause flag: it is the watcher's rule (`IsWatcher()` true at the physics and timer
   sites) switched on at run time, plus the pause events and the clock handling of a real pause.
2. The local picture is saved: the physics-driven state as one `CaptureState` snapshot of this table; the
   local balls are hidden, never destroyed (the script holds references to them: a locked ball, a captive ball).
3. Capturing stops (`g_recordCalls` off): calls replayed from the other player must not enter this table's own
   stored values.
4. The session connects as a watcher to the address given and runs today's watch role on top: HELLO, the table
   check, keyframe, frames, the delay, smoothing.

Every put replayed onto a local object while watching is preceded, the first time that (object, property,
index) is touched in this watch phase, by a read of its current value into an **undo list**. That is what makes
the way back exact without knowing what the file-loaded value was.

**Leaving watch** (`play`, or the control connection lost, or the stream refused):

1. The watcher connection closes; the watcher's balls are destroyed; every sound stops.
2. The undo list is replayed newest first. Calls with no readable value are put back by rule: sticky methods
   and reels from this table's own stored calls (the keyframe store), a playing `LightSeq` stopped, an endless
   primitive animation stopped unless the local store says it runs.
3. The saved snapshot is applied to this table (`StateApplier` on itself), the local balls are shown.
4. The clocks are re-based as at the end of a pause (no catch-up burst of physics for the time spent watching),
   the `UnPaused` event fires, capturing resumes, the static pre-render is marked dirty.
5. `state playing` goes out on the control connection.

**Fail-safe.** Anything that goes wrong ends in "playing", with the player's own table back: a refused stream
(table mismatch), a watcher connection that never opens, a lost control connection. A player is never left
looking at someone else's table at their own turn. An unknown or empty control line is ignored (rule 13).

**As built** (castcade-vpx branch `castcade/handoff`, 2026-11-19), where it differs from the steps above:

- VPX 10.8.0 fires no `Paused` event when its window loses the focus; what pauses the music and VPinMAME there
  is `Player::PauseMusic` (reference counted), so the match role calls that and its counterpart.
- Every script event is held while watching, not only timers and hits, and keys are swallowed; at the return
  the script gets the net difference (a flipper let go while watching gets its key-up).
- The own state is not one `CaptureState` snapshot: movers, hit animations, clock, balls, music, materials and
  the table's runtime fields are saved and restored field by field, because `StateApplier` clears animation
  flags and carries no velocities. Sticky methods, reels, light sequences and primitive animations come back
  from that saved state, not by rule.
- A keyframe assumes a table no script has touched, and a match table has been scripted. So the role reads a
  property before its own script's first put of it, and at each keyframe puts those values back for whatever
  the keyframe does not carry (a lamp lit in my game and never touched in the other player's).
- The own table is not touched until the other player's keyframe arrives: a watch that never connects costs
  only the pause.
- The static pre-render is not rebuilt at a switch (a 100 ms frame each time); `CASTCADE_STREAM_STATICREFRESH=1`
  turns the rebuild on.
- The first frame of a watch has 4 s (the companion waits 5); reasons after `state failed`: `refused`,
  `timeout`, `stalled`, `lost`, `closed`, `badaddress`. While a table watches, the watchers it already serves
  get its frozen state; new ones are held (rule 10).
- With the sound replay on, the watch role's stop-all kills the own table's looping sounds and they do not come
  back; a match runs with the replay off (§4.4), where nothing is stopped.

Measured on the desktop, two instances, the hand-over in three orders by turns (`tools/castcade/match-test.ps1`):
50 of 50 swaps on Nudge Test, Attack from Mars and Flash, 30 of 30 on Monster Bash; in every watch phase the
physics state came back identical and 0 of 3,913 to 49,263 compared properties differed; 0 failed replayed
calls; `play` answered in about 20 ms, `watch` in 40 to 60 ms; the switch itself costs 1.1 ms in and 1.3 ms out.
One 98.7 ms frame (Flash) and one 95.3 ms frame (Monster Bash) fell near a switch, both inside the NVIDIA
OpenGL driver. Not run: VR, a patched table (the hook), sound replay on, two PCs.

**Not in this iteration.** A local game that keeps running underneath while its owner watches (a hidden
"shadow" table): every script write would have to be diverted. The pause is what a waiting player's table does
anyway, and it also stops a waiting machine's ball search.

## 3. The control connection (fork ↔ companion)

`CASTCADE_STREAM_CONTROL=connect:127.0.0.1:<port>`: the fork connects to the companion (loopback only, so no
firewall prompt), retries every 2 s, and falls back to "playing" whenever the connection is down. UTF-8 lines
ending in `\n`.

| Direction | Line | Meaning |
|---|---|---|
| fork → companion | `hello 1 <build> <editables> <table-hash> <stream-port>` | once per connection; `1` is this protocol's version; the table identity is the one the stream's own HELLO check uses; the port is rule 9 below |
| fork → companion | `state playing` | own table shown and live (also the first line after `hello`) |
| fork → companion | `state watching` | the first frame of the other player's table is on screen |
| fork → companion | `state failed <reason>` | a `watch` did not work (refused, no answer in 10 s); followed by `state playing` |
| companion → fork | `watch <host>:<port>` | watch the stream at that address; a second `watch` re-aims (the next player is up) |
| companion → fork | `play` | come back to the own table |

An older fork build ignores `CASTCADE_STREAM=match` (no session: plain VPX), so no control connection ever
arrives; the companion then treats that PC as having no 3D (§4.2).

Rules both sides rely on (fixed 2026-11-19, when the companion half was written):

1. The fork sends `hello`, then `state playing`, without waiting; the companion sends nothing before that.
2. Every `watch`, a re-aim included, is answered within 5 s by `state watching` or `state failed <reason>`.
   Unanswered, the companion sends `play` and shows the 2D video for that turn.
3. After `state failed` the fork comes back by itself and sends `state playing`; the companion sends no `play`.
4. A `play` while already playing is answered with `state playing` again.
5. After `play` the companion sends no `watch` until `state playing` arrives or 2 s pass; then one may follow
   at once.
6. A fork that leaves a watch by itself says `state failed <reason>`, then `state playing`.
7. The table identity is compared between PCs as exact text (`<editables> <table-hash>`); the build is not
   compared. Each `hello` field is one token of printable ASCII, 128 characters at most.
8. A line of more than 2048 bytes closes the connection.

Added after the independent review of PR #76 (2026-11-19):

9. `hello` carries a fifth field, the port the fork's stream listener is bound to on 127.0.0.1:
   `hello 1 <build> <editables> <table-hash> <stream-port>`. The companion offers that port to the other
   players, not the one it asked for, so a stale or reused port can never be offered.
10. **The hand-over.** At a grant the previous player's fork is sent to watch at the same moment the new
    player's fork is called back, so a watcher can reach a fork that is still watching or still restoring its
    own table. A `match` fork that is not playing accepts the connection and holds it (no HELLO, no keyframe)
    until it is playing, then serves it as any watcher; held 10 s at most, then closed.
11. A re-aim arrives as `watch` with the same address as before (the tunnel has one listener for every
    player): the fork drops its watcher connection and connects again, and sends no `state playing` between
    leaving one player and showing the next.
12. A watch whose stream delivers no frame for 3 s is left by the fork itself (`state failed stalled`, then
    `state playing`), so a stream that stalls without closing ends in the 2D picture, not a frozen table.

Added after the independent review of the fork branch (2026-11-19):

13. An unknown or empty control line is ignored by the fork (logged, no `state` line, the watch goes on), so a
    newer companion can add a command. Loopback means a numeric address in 127.0.0.0/8 or `localhost`, for the
    control address and for the host of a `watch`.
14. A watch that ends before its keyframe leaves the own game as a pause of that length would: no event lost,
    no animation advanced.

That review found three defects in getting the own game back that the swap test could not see (a lamp's
second stored state left at the file's value, so the first light sequence after a watched turn switched the
player's lamps off; the own table's music destroyed at every watch; a watch that failed before its keyframe
dropping the events of parts that were still moving), and that when a table's script has no handler for the
pause event nothing pauses VPinMAME while its owner watches. The first three are a fix round on the branch;
the last is a known limit, logged by the fork at the first watch of such a table.

Known and accepted in this iteration: the lines carry no sequence numbers, so a `state playing` that crosses a
new `watch` can cost that turn its 3D (it falls back to 2D and heals at the next turn); the 2 s limit on the
turn lock lifts it without knowing where a slow fork is.

## 4. The companion (I11.4.2)

### 4.1 Transport

`watch/tunnel-end.ts` and `watch/tunnel.ts` are used as they are: one data-only WebRTC connection per other
player, loopback sockets to the local VPX. Only the signalling differs: `sendSignal` goes out as `MEDIA_SIGNAL`
with a new channel value `stream` (the enum is `rtc | video` today), so **protocol 6**; every PC of a match is
on the same build through the updater, as at 4 and 5. The connections are opened in the lobby, long before the
first turn (I11.12: a connect took 10 to 70 s on 2026-11-18).

### 4.2 Who watches in 3D

Each companion tells the others, over the tunnel's own channel (not the match log), what its VPX reported in
`hello`: build and table identity, or "none". A PC watches player X in 3D when its own VPX is on the control
connection and X's table identity equals its own. Otherwise 2D. The setting `watch3d` (`auto` by default,
`off`) turns it off for one PC.

### 4.3 The turn

The same decision that today puts the headset in theater while another player is up drives the fork:

| This PC | Fork | Tunnel | Headset / panel |
|---|---|---|---|
| is up, or holds its table (lobby, between games, initials hold A16.2) | `play` | `setPlayerPort(own port)` | own table, as today |
| another player is up, 3D possible | `watch 127.0.0.1:<tunnel listener for that player>` | `watch(peer)` | no theater picture; the scoreboard stays |
| another player is up, 3D not possible, or `state failed`, or no `state watching` within 5 s | `play` | none | theater with the 2D video, as today |

The 2D video keeps flowing underneath in this iteration, so the fallback is instant and the sender does not
change; not encoding for watchers who are all in 3D is a later saving. The turn lock is lifted at the grant only
once the fork says `state playing` (2 s at most, then lifted anyway and logged).

As built (PR #76), where it is narrower or wider than the table:

- The fork is sent to watch only while this PC's table is **locked**. A finished game that is still ending on
  the machine (A16: bonus, the ROM's game end, initials) keeps its table, with the 2D theater as today; the
  pause would otherwise freeze a ROM before the game end the witness scores.
- The tunnel keeps this PC's stream port set for as long as its fork is on the control connection, so a watcher
  that connects a moment before this PC handles its own grant is not refused.
- Theater is off from the moment `watch` is decided, not from `state watching`: on a failure the player sees
  their own paused table for up to 5 s, then the 2D picture. A failed watch stays 2D until the next grant
  (a shoot-again to the same player tries again).
- Only theater is suppressed: a headset set to show the panel on the other player's ball keeps the panel.
- The control server lives for the app run and its port is kept in `<userData>/stream3d.json`, so a table
  left open serves the next match and a restarted Castcade gets its fork back. The stream port comes from the
  fork's `hello` (rule 9), never from the file. A connection counts for nothing until its first line is a valid
  `hello`; a fork that a newer one replaced is turned away while the newer one lives.
- `watch3d` turned off during a match calls this PC's fork back; the others can still watch this PC. With
  `watch3d` off and no fork on the control connection, the match opens no tunnel at all.
- A fork that exits, or fails to start, within 5 s with no `hello` counts as "did not start": the table is
  started in the player's own exe.
- A PC whose picture goes to the native helper's own window (a desktop rig, a SteamVR rig) gets no window while
  its table shows the other player in 3D. Open: the Electron video path still draws in the desktop panel
  (I11.4.6).

### 4.4 Launch and sound

A match table is started in the fork (`forkExeFor`) with `CASTCADE_STREAM=match`, the two addresses,
`CASTCADE_STREAM_SOUND=0` and the delay, when the fork is beside the known VPX exe and `watch3d` is `auto`;
otherwise in the known exe as today. Sound replay is off in a match because the companion already carries the
player's table sound (the audio helper's tap, ROM and music included) and mutes this PC's own VPX while another
player is up. A table the player opened by hand in their own VPX before Host or Join stays 2D.

Consequence to know: on a PC with the fork installed, match games are played and scored in the fork (Panasony's
10.8.0 plus the stream), not in that player's own exe. The witness reports the build as it is.

## 5. What proves it

- Fork, one PC, scripted (no companion): two instances in role `match` and a script on both control
  connections that swaps who plays 50 times on an original and two ROM tables. After every return: the picture
  equals the one before the watch, the local ball is where it was, the ROM game goes on to its next ball, no
  frame over 100 ms at a switch, no crash.
- Companion: unit tests with a scripted control client and the relay double: the table of §4.3, every fail-safe
  row, a PC without the fork.
- Two companions and two forks on one PC through the tunnel harness.
- The rig gate (owner + Krobs): a two-game match in the headsets, each watching the other in 3D, with the ROM's
  sound; one of them then joins with `watch3d` off and sees the 2D picture.
