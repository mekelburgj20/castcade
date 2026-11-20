# Castcade setup probe

A small script that reports what is installed and configured on your pinball machine, so we know
what to expect before you install Castcade. Run it once and send back the one file it writes.

## What it reads

Only reads, never changes anything: Windows version and graphics cards, your screens, game
controllers and input boards, the Visual Pinball X, VPinMAME, B2S Server and DOF installs (versions
and the settings that matter for play), PinUP / PinballX / PinballY if present, your tables folder
(file names and sizes, and any `.vbs` script file beside a table, to see whose it is; no table file is opened), Windows Defender's Controlled Folder Access, and
Castcade itself if it is installed.

It does not read passwords, tokens or the content of any log, and it does not use the network. Your
Windows user name and profile folder are replaced by `<user>` and `%USERPROFILE%` in the report.
It needs no administrator rights and starts or stops nothing.

## What it writes

Exactly one file: `castcade-probe-<date>-<time>.txt`, next to the script (or on your Desktop if that
folder cannot be written to).

## How to run it

1. Unzip the folder anywhere.
2. Double-click `Castcade Probe.cmd`. It takes a few seconds (up to a minute with a large table
   collection) and prints a short summary: lines starting `OK`, `CHECK` or `PROBLEM`.
3. Press a key to close the window.

If it says it could not find Visual Pinball X or your tables, run it again from a PowerShell prompt
and point it at them:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File castcade-probe.ps1 -VpxDir "D:\VPX" -TablesDir "D:\VPX\Tables"

`-OutDir <folder>` chooses where the report goes.

## What to send back

The `castcade-probe-....txt` file, to whoever asked you to run this. Open it in Notepad first if you
like; everything it contains is plain text.
