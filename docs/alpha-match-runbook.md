# Castcade alpha match runbook (two players, both in VR)

For the owner (host) and Krobs (client), first Castcade match. The design behind it is
[`design/alpha-match.md`](design/alpha-match.md); the single-player setup is in [`tester-kit.md`](tester-kit.md).
Anything marked "(to confirm on the build)" is not settled until we see it run.

Table: ________ (ROM ______)

## 1. Before the night (each player, about 15 minutes)

- [ ] **Castcade 0.2.22 or newer**, from the GitHub releases page
  (<https://github.com/mekelburgj20/castcade/releases>). An installed copy updates itself; check
  the version on the Status tab. After an update, restart VPX: a VPX left running keeps the older headset layer (the
  Match tab says "VPX started before this layer was registered"). From 0.2.36 the camera is the VR layer sending one
  eye (ADR 0009): no preview window is captured on a VR rig, so PuP and DMD windows may sit anywhere; the first start
  after the update migrates your match settings once (`match: match.json from before 0.2.36` in the log).
- [ ] **VPX not as administrator.** A VPX run elevated hides its modules from Castcade: the Match tab reads
  "monitor (desktop panel) … vrclient not loaded, compositor not running" whatever the headset does. Untick *Run this
  program as an administrator* (the VPX exe → Properties → Compatibility), then **restart VPX**: the change applies
  to the next launch only (two joins on 2026-11-06 probed the old, still-elevated VPX).
- [ ] **The same table file on both PCs**: the table and ROM written in the line at the top. Copy the file, do not
  download it twice from different places. Castcade compares the two files and warns "different table file" if they differ.
- [ ] **Patched**: Castcade, Settings, **Import tables for live scores**, Browse to your `tables` folder,
  **Patch my tables** (same as step 5 in the tester kit).
- [ ] **VPX in VR** with the preview window on. In your `VPinballX.ini`, under `[PlayerVR]`, set
  `VRPreview = 1`, `PreviewWidth = 1280`, `PreviewHeight = 720`. The other player sees this window, so a small
  window means a poor picture.
- [ ] **One eye, not Both Eyes (ADR 0009, 2026-11-04):** the other player sees your table as a flat screen, so keep
  VPX's VR preview on **Left Eye** (`VRPreview = 1`, as above). Both Eyes (`VRPreview = 3`) sends two pictures side
  by side and the Match tab tells you to switch back. A window the size of the monitor (1920x1080 on 1080p) is
  presented full screen once VPX has focus and the screen capture then stops at one frame (Krobs' rig, 2026-11-02:
  D7.4.10), and rows of a window hanging below the screen are not sent (his 1080-row window lost its bottom 168
  rows); the Match tab warns in both cases. Castcade reads `VRPreview` from your `VPinballX.ini` (the one beside
  VPX's exe, else `%APPDATA%\VPinballX`); if you start VPX with `-Ini <another file>`, pick what the window shows on
  the Match tab under **Your preview**. With **Camera: VR layer** none of this matters: the picture comes out of VPX's
  headset view, no preview window needed.
- [ ] **SteamVR running** (the headset panel is drawn through it).
- [ ] **A headset microphone chosen** on the Castcade **Match** tab. Do not leave it on "default": in VR the Windows
  default is often a virtual device (Steam Streaming Microphone, Virtual Desktop Audio) that records silence.
  On Virtual Desktop the headset microphone is "Microphone (Virtual Desktop Audio)" and only exists while microphone
  passthrough is on in the Virtual Desktop settings (the Streamer or the in-headset menu); reconnect the headset after
  turning it on.
- [ ] **Host only:** forward **TCP 27401** to your PC in your router. In a typical router page this is under
  "Port forwarding", "Virtual server" or "NAT"; add a rule, TCP, port 27401, to your PC's local address. Know your
  public IP (Castcade shows it in the invite; <https://api.ipify.org> also tells you).
- [ ] **Client only:** nothing to forward.
- [ ] **Windows Firewall:** the first time you press **Host**, Windows asks whether Castcade may use the network:
  allow it (tick **Private**, and **Public** too if Windows calls your network public).

## 2. Rig checks the owner runs alone first

Run these a day or more before the match. If one fails, stop and send what is listed; do not start the match night.

1. **Hand-made `turn.lock` in VR** (15 minutes). Open the patched table in VR and start a game. Create an empty file
   named `turn.lock` in `%LOCALAPPDATA%\Castcade\lock\`.
   - Expected: flippers, plunger, Start and nudge go dead. Delete the file: they come back. Try the controller
     buttons as well as the keyboard.
   - If a controller button still works with the file there: send the table, which buttons, and the VPX build.
2. **Ball left in the shooter lane for five minutes.** Start a game, plunge nothing, wait five minutes.
   - Expected: nothing drastic (no ball save used, no auto-plunge that scores, no attract-mode reset). Then play on normally.
   - If something changes: send what happened, how long it took, and the table and ROM.
3. **The panel in the headset.** With SteamVR running, open Castcade, **Match** tab.
   - Expected: the tab says **overlay: showing** and the panel appears at the bottom of your view, readable at
     arm's length. (Whether a solo test with no match draws the panel is to confirm on the build.)
   - If not: send the exact text of the overlay line, and a phone photo of the headset view if the panel is there
     but unreadable (too small, too low, too faint).

## 3. Match night, step by step

1. Both: start SteamVR and Castcade; open the **Match** tab. Check your microphone pick.
2. **Host:** press **Host**. Castcade shows the invite (`castcade:ws://<public ip>:27401#<code>`) and a
   reminder to forward TCP 27401. Windows may ask to allow Castcade through the firewall: allow it.
   **Copy invite** and send it to Krobs (Discord or text).
3. **Client:** paste the invite under **Join**, press **Join**.
4. Both: you should each see both names in the roster, with the rig (VR headset) next to each. If the table files
   differ, a line says so on both screens: stop and fix that first.
5. Both: load the table in VR (patched, preview window up). Leave it at the attract screen. **Do not press Start.**
6. **Host:** press **Start match** (3 balls each). From now on the table is locked for whoever is not up.
7. **What you see and hear, each turn:**
   - **Not your turn:** the flippers, plunger, Start and nudge do nothing. The panel in the headset shows who is up,
     their table video, and the scores. You can talk the whole time (open mic; the panel shows the mute state; how
     to toggle it is to confirm on the build).
   - **Theater (D7.4, Virtual Desktop / Oculus rigs, the Castcade OpenXR layer):** when the other player's ball
     starts, your view dips to black for a moment and their table appears in front of you, where yours was, in the
     dark: straight ahead of where you are looking then, tilted down with your gaze (D7.4.7), so keep looking at
     your playfield as their ball starts. It is a flat screen (ADR 0009: 2D, one of their eyes or their player
     window), life size by default, and it stays put in the room when you turn your head; the view around it is
     dark. The Match tab's **Theater size** makes it smaller (and sharper). On your ball it dips again
     and your own table is back with nothing over it. In the lobby
     and at the end the panel sits low in your view, under the playfield. The Match tab has a setting for each
     ("In the headset on your ball", "on their ball") if you would rather have the panel. If theater does not
     appear, the VPX running was started before this Castcade: restart VPX once.
   - **Your turn starts:** two rising tones in the headset, and the panel says `YOUR BALL 1` (then `2`, `3`). The
     lock lifts at that moment.
   - The first time your turn arrives, press **Start** yourself to begin your one-player game, then plunge.
     Start does nothing before your first cue. Later balls need no Start.
   - **Your ball drains:** one low tone for "opponent up"; the table locks again; the panel switches to the other player.
   - Order: ball 1 for each of you, then ball 2 for each, then ball 3.
8. **After both last balls:** a chord plays and both panels show the standings. Then press **Leave** on the Match tab.
9. **Both scores also land on ArcAid** as normal Witness scores in the test room, Flippin Fear Fest
   (<https://arcaid.app/arcaid_flippin_fear_fest_26/>). Quit the player normally after game over and the score
   posts within a minute, as in the tester kit. The match result itself is not on arcaid.app yet.

### Table sound (D2.8)

Each of you runs your own VPX, so without help you would hear only your own table all match long. Castcade's
table-sound helper (`castcade-audio.exe`, installed with Castcade; nothing to set up) fixes that:

- **On the other player's ball:** your own VPX goes silent (its backglass and PinUP screens too), and you hear
  **their** table, sent from their PC next to their voice. Their game-over music, and yours after your last ball, play
  only on the PC whose turn it is.
- **On your ball:** your VPX sounds as normal, and your table's sound goes to the others.
- **In the lobby, at the result, after Leave, and if Castcade quits or crashes:** your VPX sounds as normal again. A
  session you had muted yourself in the Windows volume mixer is never unmuted by Castcade.
- **Match tab, "Table sound":** three switches, all on: *Mute my table while others play*, *Send my table's sound*,
  *Hear the other table*. Turn one off if it gets in the way (for example, keep your own table on if you stream it).
- What to expect: their table reaches you about as late as their video (a fraction of a second). The first sound of a
  table that only just opened can slip through for up to 2 s before your VPX goes quiet.
- **"Table sound unavailable"** on the Match tab means the helper is not in this build or did not start: every
  player hears their own table, as before, and the match is otherwise unaffected. **"Sending your table needs
  Windows 10 2004 or newer"**: your VPX is still muted on their ball, but the others cannot hear your table.

### Voice over the game (D2.10, 0.2.36)

Both of you heard the table over the other player's voice on 2026-11-04. Three sliders on the Match tab, under
"Voice and table sound", are saved and take effect at once, mid-match:

- **Voice volume** (default 150 %; above 100 is a boost): how loud the other players' voices play on your PC.
- **Their table sound** (default 100 %): the player up's table as you hear it on their ball.
- **My table while I play** (default 100 % = untouched): Castcade lowers your own VPX to this while you are up, so
  the voices sit over your game, and puts it back after your ball (and if Castcade quits or crashes).
- **While playing, with VPX in focus:** Ctrl+Alt+Up / Down changes the voice volume in steps of 10, Ctrl+Alt+Left /
  Right lowers / raises your table while you play. Each press ticks at the turn-cue volume so you hear where it is
  without looking; the Match tab's sliders follow. If a chord does nothing, another program holds it (the log says
  `match: Control+Alt+Up is held by another app`); tell the lead which one.

## 4. If something goes wrong

- **The match socket does not connect.** Host: is TCP 27401 forwarded to the right PC; does the invite's IP match your
  current public IP; did you click Allow on the Windows firewall prompt for Castcade? If the invite shows a local
  address (192.168...), the IP lookup failed: put your public IP in by hand. Client: paste the whole string,
  including the `#` and the code after it.
- **No video of the other player.** Video only shows while that player is up. On the up player's PC: is the VR preview
  window on (`VRPreview = 1`), 1280x720, not minimized? On the Match tab, read the capture source line: it should
  name the VPX preview window, not the editor or the desktop.
- **No voice.** Pick the headset microphone by name on the Match tab. Check the mute state on the panel. Check
  Windows has not muted or disabled the headset mic.
- **I hear my own table on their ball, or not theirs.** Read the Match tab's Table sound line, and look in
  `companion.log` for `audio:` lines (`audio: muted VPX pid N (k sessions)` on their ball, `audio: tap on` on yours)
  and `match: table sound:` lines. "0 sessions" means Castcade muted the wrong process or VPX had not played a sound
  yet; send the log. **My VPX stayed silent after the match:** quit and reopen Castcade (it restores what it muted),
  or unmute VPX in the Windows volume mixer.
- **No panel in the headset.** SteamVR must be running before the match starts. Read the overlay status line on the
  Match tab; if it names an error, send it. Restarting Castcade after SteamVR is up is safe.
- **The flippers stay dead after your cue.** Delete `%LOCALAPPDATA%\Castcade\lock\turn.lock` by hand and play on, then
  report it with your log.
- **The other player dropped.** The match pauses. They reopen Castcade and paste the same invite again; it resumes
  where it was. If the host dropped, the host presses Host again and re-sends the invite (to confirm on the build).

## 5. What to send the lead after the night

- Both `companion.log` files (`%APPDATA%\Castcade\logs\companion.log`; no tokens in it).
- The match id (shown on the Match tab; to confirm on the build) and the table and ROM.
- Which of the three rig checks passed, and which turns went wrong, with the rough time.
- A screenshot or phone photo of the headset view if the panel looked wrong (size, position, readability).
- What ArcAid showed for your score in Flippin Fear Fest.
