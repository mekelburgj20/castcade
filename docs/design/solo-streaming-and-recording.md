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
