# Castcade tester kit (v0.2.3, October 2026)

Everything a tester needs on one page. The full guide with details and troubleshooting is
[`phase-2-witness.md`](phase-2-witness.md); this page is the short version to send with the invite.

## The ask (about 15 minutes)

Install a small tray app, pair it with your ArcAid account, play one game of pinball to the end, quit the
player, and tell us what happened. Nothing in your Visual Pinball setup is changed.

## What you need

- Windows 10 or 11, 64-bit; **Visual Pinball X 10.8.0** with VPinMAME; launched any way you like (PinUP
  Popper, Pinball X/Y, Baller Installer, or just the editor).
- A **ROM table** with a *last game* map. Known good: **Monster Bash** (`mb_106b`), **Medieval Madness**
  (`mm_109c`), **Tales from the Crypt** (`tftc_400`). Classic Williams/Bally WPC, Data East and
  Sega/Whitestar tables are safe bets. Modern Stern (SAM/SPIKE) and original (non-ROM) tables post nothing
  in this build.
- An **ArcAid account** at <https://arcaid.app> that is a **member of the test game room, Flippin Fear Fest**
  (<https://arcaid.app/arcaid_flippin_fear_fest_26/>); join it there first if you are not in it yet.

## Steps

1. **Download** `Castcade-Setup-0.2.3.exe` from
   <https://github.com/mekelburgj20/castcade/releases/tag/v0.2.3>.
2. **Install.** It is not code-signed yet, so SmartScreen says *Windows protected your PC*: click
   **More info → Run anyway** (the browser may also ask you to *Keep* the file). No admin prompt.
   Castcade starts in the tray (the **C** icon; click the arrow by the clock if Windows hides it).
3. **Pair.** In ArcAid: **Account Settings → Arcaid Witness → create a pairing code**. In Castcade (click the
   tray icon): type the code, **Pair**.
4. **Route it.** Back in ArcAid's Account Settings, your new device is listed: set **Send scores to**
   **Flippin Fear Fest** and its tournament **Flippin Fear Fest 26**. Without this step the score goes to your Global record instead of
   the tournament board.
5. **Play one game, one player, to the end** on a ROM table. Let the last ball drain, wait for game over,
   then **quit the player** (Escape → Quit, or your frontend's exit). Do not kill VPX from Task Manager.
6. **Check.** Open Castcade → **Status**: *Watching*, *Paired*, your VPX exe, the NVRAM folder, **Sending
   to** showing the room and tournament, and **Last capture** with the table, ROM, score and
   *posted to ArcAid*. Within a minute the score is on the tournament board with the Witness badge.

## Send back

- A screenshot of **Status** after the game (and of anything red).
- The log: `%APPDATA%\Castcade\logs\companion.log` (no token in it).
- Which table and ROM you played, your VPX build (`VPinballX64.exe`, `VPinballX_GL64.exe`, VR...) and
  frontend, and what ArcAid showed.
- If the install itself was a problem (SmartScreen, Defender, antivirus), say exactly what you saw.

## Good to know

- Opening a table from the editor without `-Play` is fine; the capture happens when you close the player.
- Two-player games are skipped on purpose. Games under 20 seconds are skipped.
- *skipped: no map for ROM* means that ROM has no last-game map yet; try one of the known-good tables.
- Castcade updates itself from GitHub; when a new version has downloaded it installs on the next quit.
- Uninstall: Castcade → Pairing → **Unpair**, then Windows Settings → Apps → Castcade → Uninstall.
  Delete `%APPDATA%\Castcade` by hand if you want the settings and log gone.

## Copy-paste invite

> I'm testing a small Windows tray app called Castcade that posts your VPX scores to ArcAid
> automatically (it's the desktop version of the Arcaid Witness). Takes about 15 minutes: install,
> pair with your ArcAid account, play one game to the end, quit the player, send me a screenshot and a
> log. It changes nothing in your VPX setup and uninstalls cleanly. Steps:
> https://github.com/mekelburgj20/castcade/blob/main/docs/tester-kit.md
> Download: https://github.com/mekelburgj20/castcade/releases/tag/v0.2.3
