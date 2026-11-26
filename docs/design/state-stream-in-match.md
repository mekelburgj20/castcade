# The state stream inside a match (I11.3, I11.4.2)

Status: design, 2026-11-18. ADR 0011 is the ruling; `WORK.md` I11 is the tracker. Written after I11.2 passed
(owner + Krobs, both directions, 2026-11-18).

## 1. What changes for a player

In a match, while another player is up, a PC that has the Castcade VPX build and the same table (the same table
objects: the identical file, or a re-save or another download of it; §4.5, I11.4.15) shows
that player's game **on its own table, from its own head**, instead of the flat video on a screen. At its own
turn its own game is back exactly as it left it. A PC without the build, or with a table that holds other objects
(a mod), keeps the 2D video (ADR 0009), with nothing to set up. Voice, the scoreboard panel, the turn lock, scoring and the
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

**As built** (castcade-vpx, 2026-11-19: branch `castcade/handoff`, merged into `castcade/state-stream` at 9e78aef3), where it differs from the steps above:

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
  only the pause. From the `watch` command to that keyframe the own table is paused as a whole (the player's
  own pause, `Session::HoldsPause()`), so nothing moves and no event is due in those frames (rule 14); the
  own music is set aside at the `watch` command and given back on every way out, before the script hears
  of the return.
- Keys are read in every frame of that pause too and kept from the script, as while watching: a press made
  before the other table appears never reaches the own game, whatever ends the watch. A key still held at the
  return gets its key-down then (the net difference).
- Option events (the tweak menu) raised while watching are kept and fired at the return, once per kind.
- The list of properties to put back is capped at the table's put-able properties plus 256; past it the
  watch ends with `state failed overflow`.
- The static pre-render is not rebuilt at a switch (a 100 ms frame each time); `CASTCADE_STREAM_STATICREFRESH=1`
  turns the rebuild on.
- The first frame of a watch has 4 s (the companion waits 5); reasons after `state failed`: `refused`,
  `timeout`, `stalled`, `lost`, `closed`, `badaddress`, `overflow`. While a table watches, the watchers it already serves
  get its frozen state; new ones are held (rule 10).
- With the sound replay on, the watch role's stop-all kills the own table's looping sounds and they do not come
  back; a match runs with the replay off (§4.4), where nothing is stopped.

Measured on the desktop, two instances, the hand-over in three orders by turns (`tools/castcade/match-test.ps1`):
50 of 50 swaps on Nudge Test, Attack from Mars and Flash, 30 of 30 on Monster Bash; in every watch phase the
physics state came back identical and 0 of 3,913 to 49,263 compared properties differed; 0 failed replayed
calls; `play` answered in about 20 ms, `watch` in 40 to 60 ms; the switch itself costs 1.1 ms in and 1.3 ms out.
One 98.7 ms frame (Flash) and one 95.3 ms frame (Monster Bash) fell near a switch, both inside the NVIDIA
OpenGL driver. Not run: VR, a patched table (the hook), sound replay on, two PCs.

After the fix round (branch at `6a0b32b9`, the same driver, which now also compares the parts' internal state
and can sabotage the put-back to prove the comparison sees it): 50 of 50 swaps on Nudge Test, Attack from Mars
and Flash with 0 of up to 19,916 properties and 0 of up to 434 internal parts differing and the physics
identical in 51 of 51 phases; `state watching` after 46 to 63 ms (median; 236 worst), `state playing` after 22
to 31 ms (46 worst). A table with light sequences (JP's IT, 40 swaps, 36 phases begun mid-sequence): nothing
differs. A watch that dies before its keyframe (340 of them on three tables, most begun with a ball in
motion): no event fired before the keyframe, nothing differs. Music playing at the watch was playing after the
return in 31 of 31 phases, and in 13 of 13 with the sound replay on. A patched table (the owner's sidecar and
the hook, Attack from Mars, 30 swaps, then played out): the journal stood still in every watch phase and both
journals end in `game_end`. Ten minutes of watching: no growth in memory, handles or threads. Still not run:
VR, two PCs, a real loss of focus, a real tweak menu, an accelerometer, a table whose own script plays music.
Every VPX instance on this PC has one 60 to 103 ms frame inside the NVIDIA driver about 155 s after its start,
watching or not, so "no frame over 100 ms at a switch" holds only when that frame falls elsewhere.

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
| companion → fork | `quit` | close this table and VPX with it (rule 17; fork branch `castcade/quit-line`) |

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
    no animation advanced. (As built it is a pause: §2.)

Added with the fork's fix round (2026-11-19):

15. Of several commands that arrive in one read, the fork acts on and answers only the last: `watch` then
    `play` gives one `state playing`, two `watch` lines give one `state watching`. Two lines the companion
    wrote milliseconds apart can arrive that way, so the companion waits for no answer to a command it has
    since replaced. Run against the real fork with the two lines 0.7 to 0.8 ms apart: one answer each time,
    no stray fall-back.
16. A `watch` with no address is an unknown line (rule 13: no answer). A `watch` whose address is not
    loopback, has no port or port 0 is answered `state failed badaddress`, then `state playing`.

Added with the lobby's table change (A17 step 3, 2026-11-25; `companion/src/launch/vpx-close.ts`):

17. `quit` closes the fork's table and then VPX, the way the exit button held down does. The fork calls
    `m_player->SetCloseState(Player::CS_CLOSE_APP)`, the close state `PinInput::ButtonExit` asks for through
    `VPinball::QuitPlayer`: the player closes in its own frame loop, so the table's Exit event fires and a ROM
    table's VPinMAME stops and writes its NVRAM; a fork that is watching gets its own table back first, as at
    any close. No answer is sent: the control connection ends with the process. Of several commands in one read
    a `quit` is the one acted on. A fork from before the line ignores it (rule 13) and stays open: the companion
    waits 6 s, then sends VPX's main window the front-end close request (`PinSim::FrontEndControls`, CLOSE_APP;
    not `WM_CLOSE`: alpha-match.md §11.5), as it does for a VPX that is not the fork, and
    15 s after the first request it asks the person. Nothing ever ends the process by force.

    What the companion checks before it sends `quit` (as built after the review of PR #137):
    - the process asked to close is the one VPX the witness holds, the one it names the open table from; with
      two VPX open, or none it can name, nothing is sent and the person is asked;
    - the fork on the control connection is that same process: Castcade started it (the launch's pid is kept,
      `ForkLaunch.spawned`) and its `hello` names the stream port that start asked for (rule 9). A fork started
      by hand, or by an earlier run of Castcade, is not known to be it: no `quit`, its window is asked instead;
    - the witness has evidence that a game on that table would be seen (`WitnessStatus.gamesSeen`), and no game,
      no game's ending and no initials entry is on it (`main/one-step.ts`).

    The fork's side is on `castcade/quit-line` only, in no tester zip: until a build with it ships, every fork
    gets the 6 s and then the window. **Not run on a rig yet**: the fork half was compiled, and the companion
    half is tested against a scripted fork.

That review found three defects in getting the own game back that the swap test could not see (a lamp's
second stored state left at the file's value, so the first light sequence after a watched turn switched the
player's lamps off; the own table's music destroyed at every watch; a watch that failed before its keyframe
dropping the events of parts that were still moving), and that when a table's script has no handler for the
pause event nothing pauses VPinMAME while its owner watches. The first three are closed by the fix round
(§2, "After the fix round"); the last is a known limit, logged by the fork at the first watch of such a table.

Known and accepted in this iteration: the lines carry no sequence numbers, so a `state playing` that crosses a
new `watch` can cost that turn its 3D (it falls back to 2D and heals at the next turn); the 2 s limit on the
turn lock lifts it without knowing where a slow fork is.

## 4. The companion (I11.4.2)

### 4.1 Transport

`watch/tunnel-end.ts` and `watch/tunnel.ts` are used as they are: one data-only WebRTC connection per other
player, loopback sockets to the local VPX. Only the signalling differs: `sendSignal` goes out as `MEDIA_SIGNAL`
with a new channel value `stream` (the enum is `rtc | video` today), so **protocol 6**; every PC of a match is
on the same build through the updater, as at 4 and 5. The connections are opened in the lobby, long before the
first turn (I11.12: a connect took 10 to 70 s on 2026-11-18), and the match's first start waits for them (§4.5).

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
  `hello`; a fork that a newer one replaced is turned away while the newer one lives, except when the new
  `hello` names the connected fork's own stream port: that is the same VPX reconnecting, and it takes over.
- A `hello` whose stream port is `0` (the fork has no stream listener) is accepted: that PC can watch and
  cannot be watched. The reason after `state failed` is read as text: an unknown one is a plain failed watch.
- A control connection lost during a watch costs that turn its 3D: the PC shows the 2D picture at once, the
  fork returns to its own table by itself and says `hello` again about 2 s later, and the next grant is
  watched in 3D (run against the real fork: 2,020 ms).
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

### 4.5 The first turn starts in 3D (I11.4.9)

The data connections open in the lobby, and a connect between two routers took 10 to 70 s on 2026-11-18. Without
more, a match started before a connection is up begins its first turn in the 2D video and switches to 3D in the
middle of it, when the other PC is heard from (that switch stays: it is what a start "now" gets). The owner's
ruling (2026-11-19): the first turn is in 3D. So the match's first start waits, the way it waits for a table to
open, and never longer than 45 s in all.

**Who is waited for** (`match/stream3d.ts`, `startWait`). A PC, while `watch3d` is `auto` and either

- (a) its match table was started in the fork and that VPX is not ready on the control connection yet: until
  **45 s** (`FORK_HELLO_WAIT_MS`) after the table was seen open. "Seen open" is the witness finding the VPX
  process with the table on its command line, a few seconds after the start; the fork connects at its first
  frame, when the table has loaded (Game of Thrones LE, 2026-11-20: seen at 3.4 s, connected at 14.6 s, and the
  10 s this limit first had ran out 1.2 s before the hello: I11.4.13). While the table is not seen yet no limit
  runs: the lobby's wait for an open table is what holds a start from the table then, and a press of Start match
  is not held for such a PC at all. A VPX that connects after the limit still gets the PC its wait (b), from that
  moment. A fork from before the role `match` (621694f) never connects: that costs the limit once, and for the
  rest of the app's run a start in that build is not waited for (the log says so; its first `hello` undoes it). A
  launch that made no process, or a process that ended, is not waited for from that moment; or
- (b) its VPX is ready and nothing has been heard yet from some other player's PC (no capability over the
  tunnel): per player, until **45 s** (`START_WAIT_MS`) after this PC began connecting to them (its data
  connections open and the player in the match, whichever came later), unless the tunnel has given up on that
  player (no path) or its page is broken. Not from when the VPX was ready: a table left open from the last
  match, or a player who joins a minute after the host's table loaded, is waited for all the same.

Never: a PC with the setting off, with no fork, or whose fork speaks another control version. Only the lobby
before game 1: a next game and a rejoin never wait.

**What the lobby says besides** (I11.4.11, I11.4.12, I11.4.15), on the Match tab and the panel, before the start:

- the two PCs have different files of the table (the table advisory that was there: "same table, different file",
  "different table file"). Other bytes alone say nothing of 3D (I11.4.15; I11.4.11 said `not in 3D: use the
  identical table file on both PCs` here whenever the bytes differed, and on 2026-11-23 that was wrong for two
  tables of two): what §4.2 compares is the table identity the two forks name, the count of the table's objects
  and a hash of their types and names, and a re-save or another download of a table has the same one. So the line
  follows what is known of that:
  - this PC shows every other player in 3D (both VPX are up in the fork and name the same identity): the table
    advisory adds `3D works all the same: the files hold the same table objects`;
  - a player's table is known to hold other objects (both VPX are up and name different identities; or, on a
    joining PC whose table is still loading, the host said its table's identity and the copy that was started has
    another): `Not in 3D with <names>: the two table files do not hold the same table objects, so their turns are
    shown as the flat video`, on both PCs, gone when it no longer applies;
  - nothing is known yet: nothing is said of 3D.
- which table a joining PC starts: one that can report ball ends is never displaced by one that cannot (a match
  that takes turns comes before 3D). Among the copies that may be picked the order is: the host's identical file;
  then a copy with the host's table objects; then one whose objects are not known; last one known to hold others;
  only then the name (whole before title) and which was played last. A file that is not imported is started only
  when no imported copy of the game exists.
  - To know the identical file, the copies of that title that nothing has hashed are hashed (eight at most, one at
    a time, kept by path, size and time, given up at once when the match ends or the player opens a table), only
    on a PC where 3D can run.
  - To know the table objects (I11.4.15): the host says its table's in `HELLO_ACK.hostTableObjects` (never
    logged, protocol 6 unchanged), only when 3D can run on it (the fork beside its VPX and `watch3d` on): its own
    VPX's `hello` once that is up, and before that what its companion computes from the file
    (`launch/fork-identity.ts`), so a joiner does not wait for the host's table to load. The joining PC computes
    the same for its copies of that title (eight at most, one at a time, 8 s in all; a copy not read in time counts
    as not known), kept by path, size and time in `<userData>/table-objects.json` with the version of the
    computation; what a fork itself reported for a file Castcade started in it is kept over anything computed. A
    host that says nothing (0.2.46 to 0.2.50, or a file it cannot tell) is waited for 3 s when this PC has more
    than one copy to choose from, and the copies then rank as before I11.4.15.
  - When an imported copy is started although the host's file is on this PC, not imported, the launch state and
    the lobby line say: `For 3D: the host's file is on this PC as "<file>", not imported. Import it in Castcade and
    rejoin`; when the imported copy holds other objects and a copy that is not imported holds the host's: `For 3D:
    "<file>" on this PC holds the same table objects as the host's file and is not imported. Import it in Castcade
    and rejoin`. Neither is said when the copy that was started already holds the host's objects, nor for a host
    whose PC said that no fork runs its table. Importing it automatically is not built.
- this PC has the fork beside its VPX and `watch3d` on, and the table that is open is not on the control
  connection (opened by hand, open before the match, left from a 3D watch session, started while `watch3d` was
  off): `Not in 3D: this table is not running in the Castcade VPX build. For 3D it has to be started again by
  Castcade: close VPX, then host or join again`. When Castcade itself tried the fork for this match and it did not
  start: `Not in 3D on this PC for this match: the Castcade VPX build did not start (the log has the reason)`. Not
  while a table Castcade started is still loading, not for the 5 s a fork that dropped off the control connection
  is given to be back, not for a build that never connects, not on a PC without the fork or with `watch3d` off;
  gone when it no longer applies.

**How the host knows.** Each PC says it in the lobby with `PARTICIPANT_UPDATE.stream3dWaitMs` (the ms left of its
own wait; 0: settled), the host's own through `updateLocal`; the host lists everyone it was told of in
`HELLO_ACK.stream3dWait`, so every lobby can say who. Both keys are optional / defaulted and never logged:
still protocol 6 (`protocol/src/version.ts`). A 0.2.46 host strips the key and waits for nobody, a 0.2.46 client
never sends it and is never waited for. A PC that says nothing more is dropped from the host's list 2 s after
its own time ran out. A PC whose table is not open yet is listed (so there is no gap between its table opening
and its being waited for) and holds nothing by that alone.

**What waits, and the one limit** (`match/controller.ts`). A start is held while somebody on the host's list has
an open table: a start from the host's table (its 5 s countdown begins when nobody is left), and the first press
of Start match on the Match tab or the in-game menu (the match starts by itself when nobody is left). From the
moment a start is first held, the match starts within **45 s** (`START_WAIT_MS` again), whatever any PC says
after that: a PC that asks again and again, a player who joins during the hold, (a) followed by (b). The
seconds on the lobby line count toward that one moment and never go up.

**Starting now, and what ends a hold.** One press of Start match starts the match now when a start from the table
is held, and a second press does when Start match itself is held (so does Start anyway). A press of Start match
while somebody's table is still loading is never held: it is what it was before this wait existed. The engine's
`start()` and `startIn()` do not look at the list. A held Start match that comes due is a press of Start match at
that moment and nothing more: if a player joined during the hold whose table cannot report ball ends, or whose
table is not open yet, the hold is dropped and the Match tab says why (`lastError`); the next press in that
lobby is not held again (the host has waited once): it starts, or asks for the confirmation a press asks for.
Nothing is ever logged as confirmed by the host that the host did not confirm. The lobby falling below two ends
a hold of either kind, and its limit with it: a start from the table is off (the host starts a game again once
somebody has joined) and the next start is held anew.

**The lobby line**, on the Match tab and the panel:

- host, start held: `The match starts once the 3D connection to Krobs is up, or in 31 s (Start match on the
  Match tab starts it now; the first turn may then be the 2D video)` (`Start match again` after a held press).
  The headset's lobby panel stays up while a start is held, as it does for the countdown; what its peek compares
  is the line without the number (`lobbyLineKey`).
- host, nothing pressed yet: `Everyone in? Start a game on your table (or press Start match) · the 3D
  connection to Krobs is still being made (a start waits for it, 45 s at most)`. No counter: the line does not
  change by itself, so the headset's lobby panel goes away after its 8 s as before (D8.9).
- client: `Waiting for <host> to start a game on the table · ... (the start waits for it, 45 s at most)`, also
  without a counter (a client is not told whether the host's start is held).

`companion.log` gets one `stream3d:` line when a PC begins to be waited for (and for what), one when it stops
(settled, with the seconds each other PC took to be heard from after this PC's data connections opened; or its
limit; or no path; or the match started without it), and one for what it sent to the host; the host's log says
when a start is held, when it goes on, and when the 45 s end it.

Known costs and edges.

- A PC with the fork waits for a PC without one until that PC is heard from over the tunnel ("none"), which
  needs the data connection: 10 to 70 s between two routers, and the full 45 s when the other PC opens no tunnel
  at all (`watch3d` off there and no fork). Most of it passes while the tables load, and the one limit bounds
  it; saying "no fork" over the match's own channel instead would remove it (tracked by the lead, not built).
- A client's first word about its wait reaches the host a moment after its HELLO; a start in that moment does
  not wait (it switches in the middle of the turn, as before). A countdown that has begun is not stopped by a PC
  that begins to be waited for after it.
- A table that takes more than two minutes to load: the PC's "not open yet" word has expired on the host by
  then, so for the moment between the table opening and the PC's next word a start from the table is not held.

## 5. What proves it

- Fork, one PC, scripted (no companion): two instances in role `match` and a script on both control
  connections that swaps who plays 50 times on an original and two ROM tables. After every return: the picture
  equals the one before the watch, the local ball is where it was, the ROM game goes on to its next ball, no
  frame over 100 ms at a switch, no crash.
- Companion: unit tests with a scripted control client and the relay double: the table of §4.3, every fail-safe
  row, a PC without the fork.
- Two companions and two forks on one PC through the tunnel harness.
- §4.5: the rule and the limit at machine level, the engine's list, the controller's wait and its two ways out,
  and end to end with scripted forks and held signalling (`match/start-wait-3d.test.ts`, `stream3d.test.ts`,
  `main/match-host-stream3d.test.ts`); with real forks (packaged 9e78aef) and real tunnel pages in the harness's
  groups `gate` (waited for until the held connection comes up; the first turn then watched in 3D at once) and
  `gatecap` (the per-player limit; a match started without the connection begins in 2D and the watch goes out
  when the connection comes up, under the same grant).
- The rig gate (owner + Krobs): a two-game match in the headsets, each watching the other in 3D, with the ROM's
  sound; one of them then joins with `watch3d` off and sees the 2D picture.
