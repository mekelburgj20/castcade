# ADR 0009 — Spectating is 2D: the other player's table is flat video on a screen, never a stereo or head-tracked view

**Status:** Accepted (2026-11-04)
**Owner rulings:** 2026-11-04, after the 0.2.35 bench and a two-rig match on the one-eye theater screen: "I agree with
Krobs on the 2D ruling"; "That worked really well. I think this is the path I want to take. Let's forget 3D
spectating altogether and go with this." Krobs' reason, relayed by the owner: he gets sick as a passenger in a VR
racing sim because he is not in control, and watching the other player in 2D and switching back to 3D for his own
turn "is not a huge tradeoff". Not reopened without asking.
**Builds on:** ADR 0003 (one desktop app), ADR 0007 (functionality before ease of setup), ADR 0008 (the sanctioned
VPX build). **Amends:** the theater design in `docs/design/alpha-match.md` §5 (D7.4, D7.5: the stereo window is
withdrawn, the flat screen stays).
**Design:** `docs/design/alpha-match.md` §5 (theater, the layer camera, the bench); the two feasibility surveys this
decision weighed are `docs/research/vpx-scene-streaming-survey.md` and `docs/research/pinmame-machine-migration-survey.md`.

## Context

Castcade's match shows the player who is up to everyone else as video over WebRTC (D2), and on a VR rig the OpenXR
layer replaces VPX's view with that video while another player is up ("theater", D7.4). From 2026-10-31 to 2026-11-04
the theater was built toward a **stereo** picture: both of the sender's eyes, placed per eye in the receiver's headset
so the playfield fuses at life size (D7.4.5, D7.5.2, D7.5.8, D7.5.9, D7.5.10, D7.5.11), with a layer-side camera that
copies the eye renders out of VPX (D7.5) and a solo bench to measure it (D7.6). Six headset runs and three bench
sessions went into it. By 2026-11-04 the geometry was verified numerically: the layer's own log shows each eye's whole
render placed from the sender's fov (left -54..+40°, right -40..+54°) and the measured eye positions (±35.4 mm), and
the calibration pattern fuses. The remaining visual defect that night (the table "extremely long") was the Match tab's
Theater size at 60 %, which scales each eye's picture about its own axis and so multiplies every disparity by 0.6: a
stereo pair cannot be made smaller without distorting depth.

Two facts then decided the matter:

1. **The experience, not the geometry.** The owner played a table through the bench's own-table feed in the headset
   (full resolution, no encoder) and "it made me want to vomit": a head-tracked picture from a head that is not the
   viewer's, shown a few frames late on a window that does not move with the viewer, is motion the viewer sees and
   does not control. Krobs reports the same from being a passenger in VR racing sims. The stereo window's remaining
   work (per-frame render poses, interpolation, latency) would have reduced this, never removed it: the watcher is
   always looking out of someone else's eyes.
2. **The flat screen already worked.** The first theater (D7.4, 2026-10-31) was a 2.4 m flat screen 2.6 m ahead,
   showing one of the sender's eyes; it is what the layer shows whenever the sender's preview is one eye. On
   2026-11-04 the owner and Krobs played a two-game series with VPX's VR preview on Left Eye, Camera = screen capture,
   theater on: "That worked really well." Nobody was sick. The owner's complaints were about detail (the top of
   Krobs' playfield, which rollover lights were lit), frame rate, and the capture's dependence on a preview window
   on the desktop (Krobs' PuP DMD sat over his preview), all of which the layer camera and the encoder settle.

The alternative that was weighed in the same session, after the owner found basbi's **VPX Duo** (a modified VPX
10.8.0 and a modified VPinMAME64.dll that stream game state instead of video, so the watcher's own VPX renders the
table), is recorded in the two surveys. State streaming gives a watcher a native-quality, head-tracked 3D view and a
true shared machine; it costs a VPX fork with a per-class scene serialiser (8–10 engineer-weeks to a first proof) and,
for the shared machine, a VPinMAME fork with hand-written state registration per platform (8–12 weeks for WPC-95
alone) under the old MAME licence. With 2D spectating accepted, the 3D half of that case falls away; the
shared-machine half survives as a separate, later question (below).

## Decision

### 1. The other player's table is a flat picture

While another player is up, every watcher sees that player's playfield as **2D video on a flat surface**: a screen
placed in the room in the headset (the mono theater screen of D7.4, fixed where the watcher was looking when the
ball began, with Theater size as a legitimate 2D size control), the panel window on a desktop, or the playfield
display of a cabinet (ADR 0009 item D8.5). The picture is one of the sender's eyes, or the desktop player window.
Nothing stereo, nothing head-tracked, nothing that fills the field of view.

### 2. The stereo window is withdrawn, not deleted

The stereo window (both eyes placed per eye; `placeWindows`, `camera.whole`, window depth, soft edges, the
calibration pattern, the Camera view and the bench's tuning sliders) stays in the layer and the companion as shipped
in 0.2.35 but receives no further work; its open items are `dropped ADR 0009` in `WORK.md`. The Match tab defaults
to the flat path; a stereo sender still shows correctly for a receiver, because the receiver places whatever it is
sent. Removing the code is a later cleanup item, not part of this decision.

### 3. The layer camera becomes the mono camera

The layer camera (D7.5: the OpenXR layer copies VPX's eye renders and hands them to the companion, no desktop window
needed) is kept and gains a **one-eye** mode at full detail, which becomes the default camera on VR rigs. It removes
the preview window's conditions (a lit desktop, a window wholly on the display, nothing over it) and with them the
PuP / DMD overlap the owner saw in Krobs' capture. The screen capture remains the camera for desktop players and the
fallback for VR rigs without the layer.

### 4. Quality is a first-class, live control

Resolution, frame rate and bitrate of the sent picture are settings the sender can change during a match, with
presets for low bandwidth, and the receiver's readout shows what arrives. The encoder moves to hardware H.264
(Chromium's Media Foundation path) with a start bitrate at the cap; VP8 at the default ramp is what the owner saw at
"50 Mbps" and judged poor.

### 5. Watching without the headset on

A VR player may take the headset off after their ball and watch the others on a desktop monitor; the match must say
when their turn is near, wait for them to put the headset back on and confirm (a flipper button or key), then grant.
VPX stays running in VR throughout. This is the design for tournaments of many players, where a headset for the whole
session is "brutally uncomfortable and hot" (owner, 2026-11-04). Design item D8.4.

### 6. Cabinets

On a virtual pinball cabinet, while the player is locked out, the playfield display shows the spectator view
(portrait, the other players' feeds), and the backglass or DMD the standings; the player's own table returns at
their grant. AtGames cabinets reach the same through ArcAid's cabinet app (ADR 0003: the cabinet side stays in
ArcAid). Design items D8.5 and F25.

### 7. State streaming is shelved; the shared machine is a separate, later question

Scene streaming inside VPX (the watcher's VPX rendering the sender's table from streamed state) is **shelved**: 2D
video serves spectating, and its benefits were mostly the 3D view. The **shared machine** (one game, one DMD, the
end-of-game sequence at the right time, achieved by migrating the VPinMAME state between PCs at ball end) is a
product feature the owner wants and is tracked as research under the sanctioned-build lane (I10), to be started from
basbi's source if he provides it under the licence he distributes under, else from the survey's interception points.
It is independent of this decision: the picture a watcher sees stays 2D video either way.

## Consequences

### Easier
- No stereo geometry to tune across headsets; a flat screen's size and distance are plain settings.
- Watching is comfortable for people who cannot be passengers in VR, which is the population that matters.
- Resolution and frame rate can go up: one eye instead of two, and the encoder budget serves one picture.
- The desktop player, the headset player, the headset-off player and the cabinet all watch the same stream.
- The layer camera's remaining work shrinks to a mono mode and a frame-rate budget.

### Harder
- A VR watcher never sees the other table in depth. Accepted by both players on 2026-11-04.
- The headset-off flow adds a ready step before a grant, and a cue the player can hear with the headset off.
- The cabinet takeover needs a borderless (not exclusive full-screen) VPX on the playfield display.

### Locked out
- Further work on the stereo window, the whole view, window depth, soft edges, the pattern and the tuning sliders,
  unless the owner reopens this ADR.
- Twitch or any third-party streaming service as the match transport: 2–10 s of latency breaks the turn handoff,
  and the thing worth copying from such streams is the hardware encoder, which WebRTC can use directly.

## Alternatives rejected
- **Finish the stereo window** (per-frame render poses, interpolation, latency work): the geometry was already right;
  the discomfort is intrinsic to watching through another head. Rejected 2026-11-04 by both players' experience.
- **Scene streaming in VPX** (`docs/research/vpx-scene-streaming-survey.md`): native 3D for watchers at 8–10 weeks
  to a first proof plus a per-class serialiser's long tail; its main benefit is the 3D view this ADR gives up.
  Shelved, survey kept.
- **A relayed stream (Twitch)** as a stopgap: latency, accounts, public by default, re-encoding, same upload cost.
