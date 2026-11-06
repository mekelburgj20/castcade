# castcade-audio

The table-sound helper (WORK item D2.8). In a Castcade match every player runs their own VPX with the same table and
the turns alternate, so without help each rig only ever hears its own table: the owner's first run on 0.2.28 heard his
own table, and his own game-end sounds, all through Krobs' turn. This small process does the two things Electron
cannot do:

- **mute** this rig's VPX (its process tree, plus the table's COM-launched side processes `PinUpPlayer.exe` and
  `B2SBackglassServerEXE.exe`) in the Windows audio engine while another player is up, and put it back afterwards;
- **tap** the VPX process tree's own sound (process loopback) while this rig is up, so the companion can send it to the
  other players as a second WebRTC audio track next to the voice;
- **level** (D2.10, 0.2.0) the same tree's session volume while this rig is up, so the player's own table sits under the
  other players' voices ("My table while I play" on the Match tab, Ctrl+Alt+Left / Right in the game), and put it back.

Nothing runs inside VPX (ADR 0001) and nothing is installed: the helper uses CoreAudio from outside the process. The
companion side is `companion/src/media/audio-helper.ts` (spawn, commands, frame parser) and
`companion/src/media/table-audio-policy.ts` (when to mute, tap and play); the runbook's "Table sound" section is the
player-facing view.

C++17, CMake ≥ 3.20, MSVC x64; no dependency beyond the Windows SDK.

## Build

```powershell
cmake -B build -A x64            # the newest Visual Studio generator; MSVC x64
cmake --build build --config Release
# → build/Release/castcade-audio.exe
```

Release builds use `/O2` with link-time code generation and the static CRT (`/MT`), so no Visual C++ redistributable
is needed. CI (`.github/workflows/audio-helper.yml`) is the build of record: it uploads the exe as the artifact
`castcade-audio-win-x64` on every change here, and on a `v*` tag attaches `castcade-audio-<tag>-win-x64.zip` to the
GitHub release, where `npm run fetch-audio-helper -w companion` picks it up for packaging
(`--from audio-helper/build/Release` copies a local build instead). `release.yml` builds it from the tag for the
installer, as it does the VR helpers.

The source also compiles with clang against the MinGW headers (it spells out `audioclientactivationparams.h` when the
SDK lacks it, and looks `ActivateAudioInterfaceAsync` up at run time), which is how it was checked without Visual
Studio: `zig c++ -target x86_64-windows-gnu -std=c++17 -Wall -Wextra src/main.cpp -lole32`.

## Command line

```
castcade-audio.exe [--state <file>] [--version] [-help]
```

`--state <file>`: where the helper records the sessions it muted (one session instance id per line) and levelled
(`level <previous volume> <session instance id>`); deleted when it holds none. A run that finds the file at start
unmutes those sessions and puts the levelled ones back to their recorded volume first, so a helper killed while it
held a mute or a level (a crash, Task Manager) leaves nothing changed past its next start. The companion passes
`<userData>/castcade-audio-state.txt`.

Exit codes: 0 normal (also after `quit` or stdin EOF); 2 COM or the CoreAudio device enumerator did not start; 64 bad
arguments. Nothing after start-up exits non-zero.

## stdin: commands

One per line, ASCII, `\n` or `\r\n`:

| Command | Does |
|---|---|
| `mute <pid>` | Mutes every audio session of `pid`, of its descendants (a `CreateToolhelp32Snapshot` walk) and of any process named `PinUpPlayer.exe` or `B2SBackglassServerEXE.exe`, on **every** active render endpoint (a headset and speakers may both be present): `IMMDeviceEnumerator` → `EnumAudioEndpoints(eRender)` → `IAudioSessionManager2` → `IAudioSessionEnumerator` → `IAudioSessionControl2::GetProcessId` → `ISimpleAudioVolume::SetMute`. A session that is already muted is the player's own choice and is left alone (and never unmuted later). While a pid is muted the tree is scanned again every 2 s: VPX opens its DirectSound session at its first sound, the backglass later still. Answers `muted <pid> <n>`, and again whenever a rescan mutes more. |
| `unmute <pid>` | Unmutes exactly the sessions this helper muted for `pid` (a session the player unmuted meanwhile is left as it is). Answers `unmuted <pid> <n>`. |
| `tap <pid>` | Starts the process-loopback capture of `pid`'s tree (`ActivateAudioInterfaceAsync` on `VAD\Process_Loopback` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`): 48 kHz, 2 channels, float32 (16-bit PCM converted here if the client refuses float). Replaces a tap of another pid. Answers `tap-on <pid>`, `tap-error <reason>` or `tap-unavailable <reason>`. |
| `untap` | Stops the capture. Answers `tap-off` (nothing when no tap ran). |
| `level <pid> <percent>` | 0.2.0 (D2.10). Sets every audio session of `pid`'s tree (the same walk as `mute`, side processes included) to `percent` (10–100) of full volume: `ISimpleAudioVolume::SetMasterVolume(percent / 100)`, remembering each session's own volume first. Rescanned every 2 s like a mute, so a session that opens later gets it too; a new percent for the same pid moves the sessions already set. Answers `leveled <pid> <n>`, and again whenever a rescan sets more. A level and a mute may both hold the same session (the helper restores each on its own). |
| `unlevel <pid>` | Puts back exactly the sessions this helper levelled for `pid`, each to the volume it had, unless the player moved it meanwhile (then it is theirs). Answers `unleveled <pid> <n>`. |
| `quit` | Untaps, unmutes everything it muted, puts back everything it levelled, exits 0. **stdin EOF does the same**, so a companion that dies (or is killed) never leaves VPX muted or turned down; so does a broken stdout and a console close / logoff / shutdown event. |

A malformed line answers `error bad_pid <command>`, `error bad_percent level` or `error unknown_command <word>`; the
helper carries on. A 0.1.0 helper answers `level` with `error unknown_command level`, which the companion reads as "no
level here" and logs once.

## stdout: events and frames

Text event lines and binary frames share stdout (one writer lock, so neither splits the other). A frame always starts
with the magic `CAU1`; an event line never does.

| Line | Meaning |
|---|---|
| `ready <version>` | Started (after any recovery from `--state`). First line. |
| `tap-unavailable <reason>` | Process loopback cannot run here: `windows_too_old:<build>` (before 19041, Windows 10 2004) or `no_activate_audio_interface`. Sent once at start, before any frame, and again in answer to every `tap`. Muting keeps working. |
| `muted <pid> <n>` / `unmuted <pid> <n>` | `n` sessions are held muted for `pid` (on `unmuted`: were released). |
| `leveled <pid> <n>` / `unleveled <pid> <n>` | 0.2.0: `n` sessions are held at the level for `pid` (on `unleveled`: were put back). |
| `tap-on <pid>` / `tap-off` | The capture runs / stopped. |
| `tap-error <reason>` | The capture could not start (`activate_failed:0x…`, `activate_timeout`, `initialize_failed:0x…`, `start_failed:0x…`) or stopped on its own (`capture_failed:0x…`, e.g. the target exited). |
| `error <what> <detail>` | A command it could not read. |

Frames, while tapping, back to back with the lines:

| Bytes | Field |
|---|---|
| 0–3 | magic `CAU1` |
| 4–7 | byteLength, u32 little-endian |
| 8… | byteLength bytes of float32 little-endian samples, interleaved L R, 48 kHz |

Each frame is 10 ms: 480 sample frames, 3840 bytes, 100 frames a second (384 KB/s). Silence (the table playing
nothing) still comes as frames of zeros.

## stderr

Log lines, `audio: …`; the companion copies them into `companion.log` with the same prefix.

## Mute versus tap (measured)

Session mute sits **before** the process-loopback tap point: a tapped process whose session is muted taps as silence.
Measured on Windows 11 build 26200 (2026-11-01) with a 440 Hz tone at 2 % amplitude played by a PowerShell
`SoundPlayer`: tapped, RMS 0.0141 (the tone: 0.02 / √2); tapped and muted, RMS 0.0016 (the ~50 ms before the mute
landed, then zeros); unmuted again, RMS 0.0140. Frames keep coming at 100 a second throughout.

The design does not need the tap to survive a mute: a rig taps only while its player is up, and it is never muted
then. A future "play muted locally but still send" mode would have to use a different path (a per-endpoint mute does
not work either: it is downstream of the same point).

## Limits

- A session belongs to one process. A table whose sound comes from a process that is neither in VPX's tree nor named
  above (an external DOF or SSF tool, for example) is not muted; its name can join `kSideProcesses`.
- The 2 s rescan means a sound in the first 2 s of a newly opened session can still be heard (VPX opens its session at
  its first sound, usually long before the match is under way).
- Muting is per session, so another app's sound (the voice of the match itself, music) is never touched.
