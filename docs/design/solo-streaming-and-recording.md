# Solo streaming and recording (Phase 4a, WORK D1)

**Status:** plan agreed 2026-10-25; D1.0 spike next. Scope and gate come from
`arcaid-integration-gap-analysis.md` §6 "4a"; this doc holds the design and the owner's rulings.

## 1. What it is

The companion alone streams and records a VPX game: capture of the VPX window, hardware encode, an overlay
(score, ball, player, Witness badge), a direct RTMP push to Twitch or YouTube with the player's own stream key, a
local recording of each session tied to the scores it posted, and an overlay page OBS users add as a browser source.

**Gate:** the owner streams a Monster Bash game to a Twitch test channel from the companion alone, overlay live,
the recording on disk and hash-matched to the posted score; a second streamer adds the overlay to OBS as one browser
source.

## 2. Owner rulings (2026-10-25)

| Ruling | Detail |
|---|---|
| **Architecture A: ffmpeg does the video** | Desktop Duplication (`ddagrab`) cropped to the VPX window → NVENC / AMF / QSV, overlay drawn by ffmpeg. The Chromium path (Windows Graphics Capture + canvas + WebCodecs) is the fallback if the crop proves fragile or a richer burned-in overlay is wanted. |
| **ffmpeg is bundled** in the installer | A GPL build (compatible with the repo's GPLv3), pinned by release and sha256, fetched at package time like the maps corpus (`fetch-ffmpeg`, gitignored), shipped as an extra resource. Native `aac` only; no `--enable-nonfree` encoders. |
| **Default quality 720p30, 4.5 Mbps** | Higher presets (1080p30, 1080p60 at 6 Mbps) selectable. |
| **Recording retention** | Keep the last **3** sessions by default (setting) **plus every recording tied to a Sanctioned score** until its tournament closes. A second setting caps the total number of stored recordings; empty = unlimited. The Sanctioned ones count toward neither limit. |
| **Microphone off by default** | An option adds the player's microphone for commentary. |

## 3. Known facts and traps

- **Video cost (Phase 0 spike 0d, owner's rig, RTX 3090):** `ddagrab → hwdownload → h264_nvenc` at 720p30 cost 1.7 % CPU
  and 3.7 % of the encoder; VPX CPU unchanged. The GPU-resident path (`hwmap` to CUDA) failed on that ffmpeg build.
  0d captured the whole desktop; cropping to the window is new.
- **Window rect and DPI.** `ddagrab` captures one monitor (`output_idx`) with `offset_x/offset_y/video_size`. The rect must
  be in physical pixels (a DPI-unaware reader gets scaled coordinates) and relative to that monitor; DXGI output order may
  not match Electron's display order. A moved or resized window restarts the capture.
- **Audio.** ffmpeg has no Windows loopback input without a virtual device. Electron's display-media handler offers
  `audio: 'loopback'` (Windows); the companion captures it and pipes raw PCM to ffmpeg's stdin. Loopback is the whole
  system mix (voice chat, music), so the Stream page says so; per-process capture is a later improvement.
- **Measured 2026-10-25 (owner's machine, no VPX, 1280x960 crop of monitor 0 → 720p30 NVENC + silent PCM, 20 s):** 600
  frames at a constant 30 fps, AAC exactly as long as the video, overlay text redrawn live. Two traps found:
  Desktop Duplication delivers a frame only when the screen changes (a still desktop gave 192 frames in 20 s), so the
  graph has an `fps` filter to keep the output constant-rate; and `drawtext`'s `reload` file must be overwritten in
  place: replacing it by rename made ffmpeg's per-frame open fail ("Permission denied") and stopped the encode.
- **VR.** With `VRPreview = 0` (the owner's ini) the desktop window shows nothing; a VR streamer sets one eye, and the cost is
  read against the headset's 90 Hz budget, not the uncapped desktop rate.
- **Stream key** encrypted with Electron `safeStorage`, never sent to ArcAid, never logged.

## 4. Build order (each step ships alone)

| Step | What |
|---|---|
| **D1.0** spike | On the owner's rig: loopback audio from Electron piped into ffmpeg; `ddagrab` cropped to the VPX window (DPI, monitor index); overlay text refreshed live (`drawtext` `reload`); a two-minute RTMP push to a Twitch test channel; frame cost read with the F11 overlay, desktop and VR with `VRPreview` on. Output: the exact ffmpeg graph and any change to this plan. |
| **D1.1** OBS overlay | A local page on 127.0.0.1 with live score, ball, player and badge from the witness (server-sent events). No capture involved. |
| **D1.2** recording | MP4 per session with game start / end markers; a hash-chained manifest (file sha256, previous entry, the score each game posted); retention per §2. |
| **D1.3** streaming | Twitch / YouTube ingest, key in `safeStorage`, bitrate presets, reconnect with backoff, health (bitrate, dropped frames). |
| **D1.4** burned-in overlay | The D1.1 data drawn into the stream and the recording. |
| **D1.5** Stream page | Go live, record, preview, health, settings (quality, retention, microphone). |

ArcAid is not needed until a later step sends the recording's hash with the score.

## 5. D1.0 runbook (owner's rig, ~20 minutes)

Done without VPX on 2026-10-25 (`--desktop`): DXGI outputs found (two 2560x1440, by monitor handle), Electron loopback
audio flowing ("System audio" track, a 5 s test tone recorded whole with no dropouts), overlay redrawn live, 240/240
frames at 720p30 NVENC, audio and video of equal length. What needs the rig:

1. `git pull`, then `npm ci` at the repo root (once).
2. Open Monster Bash in VPX (the desktop build, windowed or fullscreen) and start a game.
3. In another terminal at the repo root: `npm run spike:stream -w companion -- --seconds 120`. Keep playing. Read the FPS on
   VPX's F11 overlay once before you start the command and once while it runs.
4. Paste back the `D1.0 | …` line with the two FPS numbers filled in, and open the MP4 it names (under `tmp/d1-spike/`):
   is the playfield framed right (no title bar, nothing cut), is the table sound there, is the overlay readable?
5. **Stream test** (a Twitch test channel, or your own channel's Stream Manager in "test mode"): in PowerShell
   `$env:CASTCADE_RTMP_URL = 'rtmp://live.twitch.tv/app/<stream key>'`, run step 3 again, watch the channel, then
   `Remove-Item Env:CASTCADE_RTMP_URL`. The key is never printed.
6. **VR (optional):** set `VRPreview = 1` in `VPinballX.ini`, play in the headset, run step 3, read the FPS inside the headset.
7. **Commentary (optional):** add `--mic` and say something.
