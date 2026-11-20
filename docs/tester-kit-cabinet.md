# Castcade Witness on a cabinet: tester kit

For two setups, both of which run Visual Pinball X 10.8.0 on Windows:

- **A.** A virtual pinball cabinet with a Windows PC inside.
- **B.** An AtGames Legends Pinball 4KP driven by a Windows PC in OTG mode.

The steps are the same for both. Where a setup differs, the step says so, and section 7 has the notes for each.

## 1. What you are testing

The **Witness edition** of Castcade: a tray app that reports each game you play in VPX to ArcAid, so a
tournament can count your scores and your attempts without anyone typing them in. This edition has no match,
streaming or VR features. Nobody has run it on a cabinet yet. That is what this test is for, so "it did not
work, and here is what I saw" is a useful result.

Time: about 5 minutes for the probe, 15 for the install, then three short games.

## 2. What it puts on your machine

Read this first, and show it to whoever maintains the cabinet.

- **The app**, for your Windows user only, in `%LOCALAPPDATA%\Programs\Castcade`. Settings and the log are in
  `%APPDATA%\Castcade`, game journals in `%LOCALAPPDATA%\Castcade`. No administrator prompt.
- **One script file beside each supported table**, after you press **Patch my tables**: same name as the table,
  ending in `.vbs`. VPX runs that file in place of the script inside the table. It is the table's own script
  with a few Castcade lines added, which write down each game start, score and game end, and note the nudge
  and difficulty settings VPX has in force.
- **One file in VPX's `scripts` folder:** `castcade.vbs`.

What it leaves alone: it never changes a `.vpx` file, and it writes nothing into PinUP Popper, B2S, DOF,
VPinMAME or VPX's settings. A `.vbs` that is already beside a table and is not Castcade's is not touched.
That table then posts one score when it closes, and a limited-attempts tournament does not count it.

Two things the maintainer should know:

- **Do not save a patched table from the VPX editor.** VPX copies the patched script into the table file when
  it saves. Remove the patches first (below), edit, then patch again.
- **A replaced table file is re-patched within seconds.** If a table is started before that happens, VPX shows
  one message box saying the Castcade patch was disabled. Press Enter, close the table and start it again.

To undo everything: Castcade → **Settings → Import tables for live scores → Remove all Castcade patches**, then
**Pairing → Unpair**, then Windows Settings → Apps → Castcade → Uninstall. `castcade.vbs` stays in the VPX
`scripts` folder until you delete it; nothing uses it once the patches are gone.

## 3. Before you install: run the probe

The probe is a script that reads how the machine is set up and writes one text file. It changes nothing,
needs no administrator rights and sends nothing anywhere.

1. Unzip `castcade-probe.zip` into any folder on the PC that runs VPX.
2. Double-click **Castcade Probe.cmd**. A window lists what it found; lines that start with `PROBLEM` or
   `CHECK` are the ones that matter.
3. Send back the file it names, `castcade-probe-<date>.txt`. It holds no password and no token, and your
   Windows user name is replaced with `<user>`.

If it says it found no VPX, tell us where your `VPinballX` exe is and we will give you the line to run.

Wait for a reply before installing if the probe shows a `PROBLEM` line.

## 4. Install and set up

You need a keyboard and a mouse on the PC for this part. On a cabinet the Castcade window opens on the main
display, which is usually the playfield.

1. **Download** the newest `Castcade-Witness-Setup-<version>.exe` from
   <https://github.com/mekelburgj20/castcade/releases>. Take the file with **Witness** in its name.
2. **Install.** It is not code-signed yet, so SmartScreen says *Windows protected your PC*: click
   **More info → Run anyway**. Castcade starts in the tray (the **C** icon by the clock).
3. **Pair.** On <https://arcaid.app>: **Account Settings → Arcaid Witness → create a pairing code**. In
   Castcade: type the code, **Pair**.
4. **Route it.** Back in ArcAid's Account Settings your new device is listed. Set **Send scores to** to the
   room and tournament named in your invite. Without this the score goes to your Global record only.
5. **Patch your tables.** Castcade → **Settings → Import tables for live scores → Browse…** to your VPX
   `tables` folder, then **Patch my tables**. Read the list it shows first: it names the tables it will patch
   and the ones it skips, with the reason. Tell us about any table you expected and that it skipped.

## 5. The test: three games

Start tables the way you always do (your frontend, your buttons). Use a table from your invite, or one of
Monster Bash, Medieval Madness, Tales from the Crypt.

1. **A full game.** One player, play to game over, wait for the game-over display, then leave the table with
   your normal exit button. In Castcade → **Status**, **Last capture** shows the table, the score and
   *posted to ArcAid*, and the score is on the tournament board with the Witness badge within a minute.
2. **A quit.** Start a game, drain one ball, then leave the table during ball 2 with your normal exit button.
   It posts as a quit.
3. **An attempt.** Only when your invite names a tournament with an attempt limit. If Status says the table
   needs **Start attempts**, press that button once. Then play one game: while it runs, Status shows
   *Attempt n of m*, and the tournament page shows one attempt used.

While a patched table is open, Status shows **Capture: live**. If it says **basic**, the line beside it says
why; send us that line.

## 6. What to tell us

Answer these even when everything worked:

- Did the flippers, the plunger or the nudge feel any different from before?
- Did the backglass, the DMD and your feedback hardware (solenoids, lights) behave as before?
- Did anything appear over the playfield during a game (a Windows balloon, a message box, the Castcade window)?
- Did your frontend start the table and come back to its menu the way it always does?
- How long did the install and setup take, and where did you get stuck?

And send:

- **The log.** On arcaid.app: **Account Settings → Arcaid Witness →** your PC **→ Get logs**, then
  **Send to Arcaid support**. If that does not work, send the file `%APPDATA%\Castcade\logs\companion.log`
  (it holds no token).
- A photo or screenshot of **Status** after game 1.
- The table and ROM you played.

## 7. Notes for each setup

### A. PC in the cabinet

- If someone else maintains the cabinet, give them section 2 before you start, and install on the drive and
  Windows user they agree to.
- If you have a second VPX install or a second drive for testing, point **Browse…** in step 5 at that tables
  folder only, and start the test tables from that folder. Castcade then writes nothing beside the tables of
  your main install.
- If a table you want to use already has a `.vbs` beside it, tell us before the test. Castcade will not
  replace it.

### B. AtGames 4KP in OTG

- Everything is installed on the **PC**, not on the cabinet. In OTG the cabinet is the PC's screens and
  controls; the cabinet's own Arcaid Witness is not involved and the PC pairs as its own device.
- Tell us which control mode the cabinet is in (Xbox controller or keyboard) and whether the flippers, the
  plunger and the nudge all reached VPX as before.
- If the PC also has its own monitor, say on which screen the Castcade window and its balloons appeared.

## 8. Good to know

- Castcade counts one-player games only. Games under 20 seconds are skipped.
- A game started while Castcade is not running, or while the PC is offline, does not count in a
  limited-attempts tournament.
- Castcade updates itself. When a new version has downloaded it offers **Restart and update** in its window
  and its tray menu; it never restarts during a game.
- A balloon *"Castcade could not keep a table patch"* means an antivirus removed the script Castcade put
  beside a table. The table still plays. Windows Security → Protection history → allow the file, then
  Status → **Patch now**.
