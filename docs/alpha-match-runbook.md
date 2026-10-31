# Castcade alpha match runbook (two players, both in VR)

For the owner (host) and Krobs (client), first Castcade match. The design behind it is
[`design/alpha-match.md`](design/alpha-match.md); the single-player setup is in [`tester-kit.md`](tester-kit.md).
Anything marked "(to confirm on the build)" is not settled until we see it run.

Table: ________ (ROM ______)

## 1. Before the night (each player, about 15 minutes)

- [ ] **Castcade 0.2.22 or newer**, from the GitHub releases page
  (<https://github.com/mekelburgj20/castcade/releases>). An installed copy updates itself; check
  the version on the Status tab.
- [ ] **The same table file on both PCs**: the table and ROM written in the line at the top. Copy the file, do not
  download it twice from different places. Castcade compares the two files and warns "different table file" if they differ.
- [ ] **Patched**: Castcade, Settings, **Import tables for live scores**, Browse to your `tables` folder,
  **Patch my tables** (same as step 5 in the tester kit).
- [ ] **VPX in VR** with the preview window on. In your `VPinballX.ini`, under `[PlayerVR]`, set
  `VRPreview = 1`, `PreviewWidth = 1280`, `PreviewHeight = 720`. The other player sees this window, so a small
  window means a poor picture.
- [ ] **SteamVR running** (the headset panel is drawn through it).
- [ ] **A headset microphone chosen** on the Castcade **Match** tab. Do not leave it on "default": in VR the Windows
  default is often a virtual device (Steam Streaming Microphone, Virtual Desktop Audio) that records silence.
- [ ] **Host only:** forward **TCP 27401** to your PC in your router. In a typical router page this is under
  "Port forwarding", "Virtual server" or "NAT"; add a rule, TCP, port 27401, to your PC's local address. Know your
  public IP (Castcade shows it in the invite; <https://api.ipify.org> also tells you).
- [ ] **Client only:** nothing to forward.

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
- **No panel in the headset.** SteamVR must be running before the match starts. Read the overlay status line on the
  Match tab; if it names an error, send it. Restarting Castcade after SteamVR is up is safe.
- **The flippers stay dead after your cue.** Delete `%LOCALAPPDATA%\Castcade\lock\turn.lock` by hand and play on, then
  report it with your log.
- **The other player dropped.** The match pauses. They reopen Castcade and paste the same invite again; it resumes
  where it was. If the host dropped, the host presses Host again and re-sends the invite (to confirm on the build).

## 5. What to send the lead after the night

- Both `castcade.log` files (the path is on Settings; no tokens in it).
- The match id (shown on the Match tab; to confirm on the build) and the table and ROM.
- Which of the three rig checks passed, and which turns went wrong, with the rough time.
- A screenshot or phone photo of the headset view if the panel looked wrong (size, position, readability).
- What ArcAid showed for your score in Flippin Fear Fest.
