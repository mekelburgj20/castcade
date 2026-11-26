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

# Castcade build check

A second, smaller script for one question: why a score's evidence says the VPX or VPinMAME build
could not be validated (ArcAid's "Known build" rule). Give it to a player whose scores are flagged
for that. Like the probe it only reads, uses no network and needs no administrator rights; it must
**not** be run as administrator, because it has to see what Castcade sees.

It reports, with the Windows user name replaced by `<user>`:

- whether each running `VPinballX*` process is elevated, the path and command line Castcade reads
  for it (both are empty for an elevated VPX, which is what makes the build unreadable), its real
  path, and which programs started it;
- whether PinUP Popper runs elevated (a table it starts inherits that, whatever VPX's own
  "Run as administrator" box says), "Run as administrator" compatibility flags and startup tasks
  with highest privileges on pinball programs, and whether UAC is switched off;
- the VPX exe and the VPinMAME DLL that VPX loads: version, SHA-256, whether it is an official
  release, and whether ArcAid passes it by version (VPX from 10.8.0, VPinMAME from 3.6.0);
- the last build lines of Castcade's `companion.log`.

How to run it: start a table the usual way (from the frontend, if the player uses one) and leave it
running, double-click `Castcade Build Check.cmd`, and send back the
`castcade-build-check-<date>-<time>.txt` it writes on the Desktop (`-OutDir <folder>` to choose).
Written on 2026-11-25 for a player whose scores failed "Known build" (WORK B32, B32.1, B33).
