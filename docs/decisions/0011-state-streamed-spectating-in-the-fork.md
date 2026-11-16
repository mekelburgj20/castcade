# ADR 0011 — A watcher may render the player's table in their own VPX, from their own viewpoint (state streaming, in the fork)

**Status:** Accepted as a direction (owner, 2026-11-15); the design below is the lead's, built the same night, and is
revert-if-wrong until the owner has stood in it (WORK I11.1) and watched Krobs with it (I11.2).
**Owner ruling:** 2026-11-15: "I want to begin work on a VPX fork that allows multiplayer VR spectator view ... one that
enables the spectator to render the other player's table play session in the spectator's viewpoint/vantage. I want to
be able to watch Krobs play, in VR from my point of view, my headtracking, his table play session ... by sending the
other player's session state to my local VPX so it can render. And vice versa. The next iteration will also tap in to
VPINMAME so that the DMD can be shared as well." Base: "I'd prefer if you used the Panasony VPX build".
**Amends:** ADR 0009 §7 (state streaming is no longer shelved) and the reach of its §1: "nothing stereo, nothing
head-tracked" still holds for the *video* a watcher is sent; it does not forbid a watcher's own VPX drawing the table
for the watcher's own head. **Builds on:** ADR 0008 (a fork of VPX is ours to maintain), ADR 0001 (VPX 10.8.0).
**Code:** `github.com/mekelburgj20/castcade-vpx`, branch `castcade/state-stream` (a fork of `Panasony1008/vpinball`,
branch `10.8.0`), `src/castcade/`. **Earlier survey:** `docs/research/vpx-scene-streaming-survey.md`.

## Context

ADR 0009 made spectating 2D after the stereo window made the owner and Krobs sick: a watcher was shown a picture
rendered for someone else's head. It shelved state streaming because its main benefit was the 3D view being given up,
and because the survey priced a first proof at 8–10 engineer-weeks (a hand-written serialiser for every part class,
"609 `propput`s, no reflection").

Two things changed. The owner asked for the 3D view again, in the one form ADR 0009's reasoning does not touch: the
watcher's own camera, moved by the watcher's own head, on a table that stands still in the watcher's room. And the
cost estimate rested on serialising state per class, which turned out to be avoidable.

## Decision

### 1. Two streams, not one serialiser

A table's visible state has two sources, and they are replicated differently.

- **What the script sets** (lights, primitive transforms, visibility, images, materials, reels, sounds, DMD pixels
  drawn inside the table). VBScript reaches VPX objects only through `IDispatch::Invoke`. Every scriptable class in the
  fork derives from `CastcadeDispatchImpl` (one template over ATL's `IDispatchImpl`, `src/castcade/CastcadeDispatch.h`),
  which reports each successful call. The player records property puts (all of them on table parts, bar a short
  exclusion list; whitelists on the table, global and ball objects) and a whitelist of methods, and the watcher replays
  them with `Invoke` on the same object. No per-class code; a property added upstream is covered the day it exists.
- **What physics produces** (balls; flipper, gate, spinner and plunger movers; bumper rings and skirts; targets;
  triggers; slingshots; the table nudge). A small per-class capture, `src/castcade/CastcadeState.cpp`, about 0.2–0.7 KB
  a frame, interpolated between two snapshots on the watcher.

### 2. The watcher is the same VPX with the script compiled and never started

A watcher loads the same `.vpx`, compiles its script (so every engine pointer is valid) and never sets the engine to
connected: no global code runs, no event is sunk, VPinMAME is never created. It runs no physics step and never pauses
for focus; its clock, light fades and animations run. Its file-loaded table is therefore identical to the player's
before the player's script ran, which is what makes a **keyframe** simple: every value the player's script has set so
far, in order, plus the current physics state.

### 3. Dedupe on the player, a timeline on the watcher

Scripts re-set unchanged values thousands of times a frame. The player keeps the last encoded value per (object,
property) and sends only changes; a recorded method on an object invalidates that object's entries. The watcher renders
a fixed delay behind the newest frame (50 ms on a LAN, 100 by default in the launcher) and interpolates, replaying each
frame's calls when its time comes, so lights change in step with the balls.

### 4. Same table file, checked

Objects are addressed by their index in the table's part list. The hello carries the part count and a hash of every
part's type and name; a watcher with a different table refuses the stream and says so. The state blob carries its own
per-class counts as a second guard.

### 5. The base is Panasony's published 10.8.0 branch

The owner's rig runs Panasony's build; its shaders are byte-identical to the fork's. The published branch is not
bit-for-bit the 10.8.0.2078 binary: one difference found (the binary reads the ini beside the exe, the branch head
ignored it without `-Ini`; fixed in the fork, commit `5fb5e2d8`).

### 6. Configuration is by environment variable, transport is plain TCP for now

`CASTCADE_STREAM=play|watch`, `CASTCADE_STREAM_ADDR=listen:[ip:]port | connect:host:port` (either role may be the one
that listens), delay, sound and log variables; with none set the fork behaves as the build it came from (each hook is
one null test). An unknown command-line flag makes VPX show a modal box and exit, which is why there are no flags.
One side needs a reachable TCP port (47800). Carrying the stream over the companion's existing peer connection is
I11.4.

**Amended 2026-11-16 (owner: "the final product will not require port forwarding ... why can we not implement that
now"; I11.4.1, companion PR #51):** the companion carries the stream. Each VPX is given a loopback address
(`listen:127.0.0.1:<port>` for the player, `connect:127.0.0.1:<port>` for a watcher) and talks only to the companion
on its own PC; the companions splice those sockets over a data-only WebRTC connection of their own (the ICE settings
voice uses), signalled through the ArcAid relay room of an invite code. The fork is unchanged, and the stream stays
opaque to the companion. It is offered as a **3D watch session** on the Match tab, apart from a match, because a VPX
is still a player or a watcher for as long as the table is open (I11.3). The directly reachable port remains as the
`.bat` launchers' fallback. A router pair with no direct path needs a TURN relay (WORK F23), as voice does.

## What was measured (2026-11-16, the owner's rig, two instances on one PC, desktop, loopback)

| Table | Parts | Stream | Replayed calls failed | Picture, player vs watcher |
|---|---|---|---|---|
| Nudge Test (no ROM, 10 balls) | 111 | about 12 KB/s at 150 fps | 0 | the watcher shows the same ten balls, including in flight while the shaker runs |
| Flash (Williams 1979) | 484 | about 46 KB/s | 0 | lamps, reel digits, score match |
| Attack from Mars (JP v600) | 553 | 26–65 KB/s | 0 | lamps, in-table DMD, flippers match; mean pixel difference 0.3–1.2 of 255 |
| Monster Bash (VPW) | 1,177 | 43–92 KB/s | 0 | matches across a 60 s scripted game |

Recording cost on the player: 26–42 µs a frame on the VPinMAME tables. Late join, watcher-first start, the reversed
connection direction and a wrong-table refusal were each run once and behaved. A fuzzer sent 178 malformed streams;
nothing crashed. **Not verified: VR** (nobody has worn a headset on it), two PCs, the internet, a GPU other than the
owner's.

## Consequences

### Easier
- A watcher sees the other player's table at full native quality, in depth, from where they stand, for well under
  1 Mbps; no encoder, no capture, no theater screen.
- Tables without a ROM work exactly like ROM tables.
- The player's cost is a few tens of microseconds a frame.

### Harder
- Both players need the fork build and the identical table file. The 2D video path needs neither and stays the default.
- VPinMAME runs only on the player's PC: a watcher has no ROM sound and no external DMD window (the owner's next
  iteration; related to I10). B2S, PuP and FlexDMD windows are other processes and do not travel.
- A VPX is a player or a watcher for as long as the table is open. A Castcade match alternates turns inside one running
  game; holding the watcher's own game still while it shows the other player's, and giving it back, is I11.3 and is the
  step that turns this from a spectator build into a match feature.
- The fork must follow Panasony's branch and upstream 10.8.x by hand.

### Locked out
- Nothing new. ADR 0009's rulings on the stereo window and on video stay as they are.

## Alternatives rejected
- **The survey's per-class serialiser** (capture every renderer-read field of every class): complete only when every
  field has a line of code, and silently wrong when one is missed. Replaying the script's own calls is complete by
  construction for everything a script can do.
- **Running the script on the watcher too** (so only balls need streaming): the watcher's ROM would be in attract mode
  while the player's is in a game, and its script would fight the stream over every lamp.
- **A script-less watcher that skips compiling**: leaves null script-engine pointers through the player's shutdown
  paths for no gain; an engine that is compiled and never started is inert.
- **Command-line flags**: an unknown flag is a modal error in stock builds and in this one, so a launcher shared
  between builds could not pass them safely.
