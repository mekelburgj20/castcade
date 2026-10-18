# Castcade Witness — tester guide (Phase 2, basic mode)

Thanks for testing. Castcade is a small tray app: install it, pair it with your ArcAid account once, play
pinball as usual, and the score of each finished one-player game on a ROM table shows up on your ArcAid
board with the **Witness** badge. It changes nothing in your Visual Pinball setup.

## 1. You need

- Windows 10 or 11, 64-bit.
- **Visual Pinball X 10.8.0** with **VPinMAME** installed. Any way of launching tables is fine (PinUP
  Popper, Pinball Y/X, Baller Installer, or just the VPX editor).
- At least one **ROM-based table** whose ROM has a *last game* map in the
  [pinmame-nvram-maps](https://github.com/tomlogic/pinmame-nvram-maps) corpus (its `index.json`
  lists every ROM; the map file it points at must have a `game_state` block). Classic Williams/Bally WPC, Data East,
  Sega/Whitestar and Gottlieb System 3 tables are the safe bets. Examples known to work:
  Medieval Madness (`mm_109c`), Tales from the Crypt (`tftc_400`).
- An **ArcAid account** at <https://arcaid.app> (sign in with the account that owns the board you
  want scores on).

## 2. Install

1. Download `Castcade-Setup-<version>.exe` from the
   [GitHub Releases page](https://github.com/mekelburgj20/castcade/releases).
2. Run it. It is **not code-signed yet** (proof of concept), so Windows SmartScreen says
   *"Windows protected your PC"*: click **More info**, then **Run anyway**. The browser may also
   ask you to *Keep* the download.
3. The installer is per-user (no admin prompt) and offers to pick the folder. Finish it; Castcade
   starts and puts an icon in the tray (the **C** with a dot; click the arrow next to the clock if
   Windows hides it).

Castcade installs to `%LOCALAPPDATA%\Programs\Castcade` and writes its settings and log to
`%APPDATA%\Castcade`.

## 3. Pair

1. In ArcAid, open **Account Settings**, find the **Arcaid Witness** section and create a pairing
   code (6 characters, expires in about 10 minutes). The companion's Pairing view has a link there.
2. In Castcade (click the tray icon or **Open Castcade** in its menu), the **Pairing** view is
   shown. Optionally change the *Device label* (defaults to your PC name), type the code, click
   **Pair**.
3. It says *Paired*. Your PC now appears in ArcAid's device list; you can revoke it there any time.

## 4. Test

1. Launch a ROM table from your usual frontend (or the editor) and play **one game, one player, to
   the end** (let the last ball drain; wait for the game-over attract mode).
2. **Quit VPX normally** (Escape → Quit, or your frontend's exit key). Do not kill it from Task
   Manager; basic mode reads the result when VPX exits cleanly.
3. Within about a minute the score appears on your ArcAid board for that table with the Witness
   badge. If ArcAid already had that exact score it is marked as a duplicate and nothing is added.
4. Open Castcade → **Status**. You should see:
   - *Watching* and *Paired* at the top,
   - *VPX exe seen*: the path of your VPinballX executable,
   - *NVRAM dir*: your VPinMAME `nvram` folder (if it says *not found*, set it in Settings),
   - *Maps version*: a short git hash,
   - *Last capture*: the table, the ROM, the score, and *posted to ArcAid*.

Repeat with a second table if you can. Leave the app running in the tray for a while: it sends a
heartbeat so ArcAid shows the device as online.

## 5. Known limits of this build

- **Basic mode only.** Castcade reads the ROM's *last game* memory when VPX exits. Killing VPX from
  Task Manager, a crash, or a Windows shutdown with VPX open loses that game.
- **One game per VPX session is posted** — the last one. Play one game, quit, play again.
- **Multi-player games are not posted** (that is Castcade's Phase 3 job).
- **Modern Stern SAM/SPIKE ROMs** have no last-game maps, so nothing is posted for them.
- **Original (non-ROM) tables** have no last-game score in basic mode. Nothing is posted.
- Scores are **added**, never changed or filtered: ArcAid's doctrine is *badge, never gate*.
- The app is unsigned (SmartScreen warning) and updates itself from GitHub Releases: when a new
  version has downloaded, the tray shows a notice and installs it the next time you quit.

## 6. What to send back

- A screenshot of the **Status** view after your test game (and of anything red).
- The log file: `%APPDATA%\Castcade\logs\companion.log` (the path is also shown under
  Settings → About). It contains no token.
- Which table and ROM you played (`Status` shows both), and what ArcAid displayed.
- Your VPX build (`VPinballX64.exe`, `VPinballX_GL64.exe`, ...) and frontend, if any.

Post it in the testers' thread or open an issue at <https://github.com/mekelburgj20/castcade/issues>.

## 7. Uninstall

1. First, in Castcade → Pairing click **Unpair**, and in ArcAid Account Settings remove the device
   (either alone is enough to stop posts; doing both keeps things tidy).
2. Windows **Settings → Apps → Installed apps → Castcade → Uninstall** (per-user, no admin).
3. The uninstaller leaves your data folder alone; delete `%APPDATA%\Castcade` by hand if you want
   it gone (settings, log, offline queue). Nothing in your VPX folders was touched.
