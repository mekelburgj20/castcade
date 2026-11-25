# Castcade ICE capture

A packet capture for one PC while a Castcade match connects (WORK I11.12.1). It answers the one question the
`ICE round` lines in `companion.log` cannot: **do the other PC's connectivity checks reach this PC's network
card at all**, from which port, and does Windows drop them?

Background (WORK I11.12): Castcade's voice and 3D connections (WebRTC inside the app) usually fail their first
round of connectivity checks, and with some pairs of PCs they never connect. Both PCs send checks; Chromium
counts none received on either side. Meanwhile the native video helper connects at once between the same PCs.
Chromium's counters cannot say whether a check was lost on the internet, at a router, or inside Windows.
This capture can.

## What it does

- Captures, with Windows' own `pktmon`, the UDP that this PC exchanges with its router (filtered on the router's
  MAC address, so a headset streamed over the home network does not fill the file), the first 256 bytes of each
  packet, at the network card.
- Every second, notes which local UDP ports belong to Castcade (`Castcade.exe`, `castcade-video.exe`).
- Turns on Windows Firewall's "log dropped packets" for the length of the capture and keeps the drops of that
  window.
- At the end, `analyze.mjs` prints a summary per ICE session (one connection attempt; an ICE restart is a new
  session): checks sent and received, answers both ways, the peer's ports, who sent first, Windows Firewall's
  drops, and the matching `companion.log` lines.

What it changes, and puts back when it stops (also on Ctrl+C): pktmon's packet filters (cleared before and
after) and the firewall's "log dropped packets" setting of each profile. It needs administrator rights and asks
for them.

## How to run it

1. Optional: `powershell -ExecutionPolicy Bypass -File tools\ice-capture\ice-capture.ps1 -Check` says what a
   capture would use and changes nothing.
2. Double-click `Castcade ICE Capture.cmd` and accept the administrator prompt. A new window says
   "Capturing".
3. Host the match (or join it) as usual. Let the other player join.
4. About a minute after they joined (or once voice works), press **Enter** in the capture window. It stops by
   itself after 10 minutes (`-MaxMinutes` changes that).
5. The window prints the summary and the folder it wrote: `ice-capture-<date>-<time>\` next to the script
   (`-OutDir` chooses another place).

To read a capture again, or one from another PC: `node tools\ice-capture\analyze.mjs <folder>`
(`--companion-log <file>` for another player's `companion.log`; `--all` to include every program's sockets).

## What is in the folder

| File | Holds | Send it? |
|---|---|---|
| `summary.txt` | the reading; no address, only ports and masked names ("peer A", "STUN server 1") | yes |
| `capture.pcapng`, `capture.etl` | the packets themselves, with this PC's and the other PC's public addresses | no: keep them on this PC |
| `sockets.csv` | Castcade's local UDP ports each second | only with the capture |
| `firewall.log` | Windows Firewall's UDP drops in the capture's minutes, with addresses | no |
| `meta.json` | times, the filter used, this PC's own addresses | no |

A PC without Node.js gets no summary: its player sends the whole folder to the person who asked, who runs
`analyze.mjs` on it. That folder holds both PCs' public addresses.

## Reading the summary

Each session ends with a `reading:` line:

- **Nothing from the peer reached this PC's network card**: the checks were lost before this PC (this router,
  the peer's router, or between them), or the peer never sent. The peer's own capture tells which.
- **The peer's checks reached this PC's network card and Castcade never answered one**: lost inside this PC
  (Windows Firewall, or Chromium). Look at the firewall drops below it.
- **the peer's checks came from a port this PC never sent to**: the peer's router gave that flow another public
  port than the one its candidates advertised. This is the "race" WORK I11.12 suspects.
- **Checks answered both ways**: that session had a working path.

The times are UTC, as in `companion.log`, so the sessions line up with its `ICE round` lines.
