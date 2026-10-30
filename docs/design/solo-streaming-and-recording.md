# Solo streaming and recording (Phase 4a, WORK D1)

**Status:** plan agreed 2026-10-25; D1.0, D1.1, D1.2, D1.3, D1.6, D1.8 and D1.9 shipped (0.2.18 / 0.2.19); D1.4, D1.5 and D1.7 open. Scope and gate come from
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
| **ffmpeg is bundled** in the installer | A GPL build (compatible with the repo's GPLv3), pinned by release and sha256, fetched at package time like the maps corpus (`fetch-ffmpeg`, gitignored), shipped as an extra resource. Native `aac` only; no `--enable-nonfree` encoders. **Built (D1.6, 2026-10-27):** Gyan's `ffmpeg-8.1.1-essentials_build` (GPLv3, static; has `ddagrab`, `drawtext`, NVENC / AMF / QSV, `tee`, RTMP), `ffmpeg.exe` + `ffplay.exe` (the framing preview), +54 MB on the installer; `scripts/fetch-ffmpeg.mjs`, `media/ffmpeg-path.ts`. |
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
- **Rotated monitors.** Desktop Duplication returns a rotated monitor's frame as the panel scans it, not as the desktop
  shows it: a portrait display (the usual desktop-VPX setup) comes in 2560x1440 with the table on its side (owner's rig,
  2026-10-27, DXGI rotation 4). The probe reads each output's rotation; the crop is mapped into the panel's frame for
  `ddagrab` and the picture turned upright after scaling (`ffmpeg-args.ts` `ddagrabRegion`).
- **VPX cabinet mode.** With `BGSet = 1` VPX draws the table turned inside a screen Windows calls landscape, for a
  monitor that physically stands portrait (the owner's switch, 2026-10-27). Nothing in Windows says so, and the turn is
  in each table's view settings (inside the `.vpx`), so the player picks a **rotate** (90 / 180 / 270 clockwise; 90 on
  the owner's rig) and checks it in the preview. The vertical slice then runs along the window's height.
- **Audio.** ffmpeg has no Windows loopback input without a virtual device. Electron's display-media handler offers
  `audio: 'loopback'` (Windows); the companion captures it and pipes raw PCM to ffmpeg's stdin. Loopback is the whole
  system mix (voice chat, music), so the Stream page says so; per-process capture is a later improvement.
- **The audio must never hold back the screen grab (2026-10-28).** One ffmpeg with the PCM on stdin and `ddagrab` in the
  same graph stuttered: the ball froze for 50–100 ms several times a second (the owner's first in-app streams: 15–18 new
  frames a second of 60, in the MP4 too, so not the network; capping VPX at 165 fps changed nothing). ffmpeg's scheduler
  holds back any input more than ~100 ms ahead of the slowest, the loopback audio always arrives late (chunks over IPC,
  then the sync trim), and a held-back `ddagrab` misses the screen instead of queuing it. A moving test pattern on the
  rig: 274 new frames in 5 s with no audio, 37 with the audio 390 ms behind; a queued `-f lavfi` input did not help. So a
  capture is two processes: `grab` (ddagrab → H.264 in Matroska on stdout, no audio) and `mux` (that stream copied plus
  the PCM → MP4 / RTMP tee), piped by the host without backpressure (`ffmpeg-pipeline.ts`): 275–276 new frames, no
  freeze, even with the audio 400 ms late. MPEG-TS between them failed: a copied TS stream keeps TS's codec tag, which
  tee's mp4 and flv muxers refuse. Bonus: a stop ends `grab`, `mux` drains and closes the MP4 cleanly (D1.8).
- **Measuring stutter.** `mpdecimate` counts the frames that differ from the one before: a constant-rate 60 fps file
  with only 15 new frames a second froze for the rest. `ffmpeg -i x.mp4 -vf "mpdecimate=hi=64:lo=32:frac=0.01,showinfo"
  -fps_mode vfr -f null -` prints each new frame's time; gaps over ~40 ms at 60 fps are visible freezes.
- **Measured 2026-10-25 (owner's machine, no VPX, 1280x960 crop of monitor 0 → 720p30 NVENC + silent PCM, 20 s):** 600
  frames at a constant 30 fps, AAC exactly as long as the video, overlay text redrawn live. Two traps found:
  Desktop Duplication delivers a frame only when the screen changes (a still desktop gave 192 frames in 20 s), so the
  graph has an `fps` filter to keep the output constant-rate; and `drawtext`'s `reload` file must be overwritten in
  place: replacing it by rename made ffmpeg's per-frame open fail ("Permission denied") and stopped the encode.
- **VR.** With `VRPreview = 0` (the owner's ini) the desktop window shows nothing; a VR streamer sets one eye, and the cost is
  read against the headset's 90 Hz budget, not the uncapped desktop rate. **Measured 2026-10-25 (rig, Monster Bash in VR,
  `VRPreview = 0`):** the player window was 640x480 and the capture all black, while the pipeline itself held (3600/3600
  frames, speed 0.997x, exit 0) and the loopback track carried the game sound (mean -27.9 dB). So the Stream page must
  detect a VR game with the preview off and say so before going live, not stream a black box.
- **Rig run 2 (2026-10-25, `VRPreview = 1`, `--mic`):** started with only the editor open, so the old "largest VPX window"
  fallback filmed the editor; about 9 s in (around when the game started) ffmpeg stopped with ddagrab's "Generic error in an
  external library", Desktop Duplication's lost-access error. Changes: the playfield is only ever the "Visual Pinball Player"
  window, the spike waits for it and lets the player settle 5 s, and the product must restart the capture when ddagrab
  loses access (a fullscreen or display-mode change), keeping one recording across the gap. The Windows default microphone
  was a virtual device ("Steam Streaming Microphone", later "Virtual Desktop Audio" while the headset streamed) and
  recorded silence, so the Stream page needs a named microphone picker, not "the default".
- **Rig run 3 (2026-10-25, VR, `VRPreview = 1`, headset mic):** 3600/3600 frames, table and voice both recorded, but the
  picture was poor and the voice buried. The VR preview window is sized by `[PlayerVR] PreviewWidth / PreviewHeight`
  (owner's ini: 640x480), and the capture can only be as sharp as that window; the Stream page should read those keys and
  advise 1280x720 or more before a VR stream. The loopback game mix is hot and a headset mic quiet, so the audio graph now
  turns the game down (50 %), compresses and raises the voice (300 %), and limits the sum; both levels are settings.
- **Rig runs 4–5 (2026-10-25):** a 1280x720 preview looked good. A tall 810x1440 preview showed VPX crops the eye image to
  the window: one eye's image is not centred on the table (left eye: the table sits right of centre), and a window as tall
  as the monitor runs under the taskbar, which then appears in the capture. A vertical stream is therefore a 9:16 slice
  of a wider preview with a sideways shift (`portraitSlice`), the preset names the short side (720p vertical = 720x1280),
  and the preview must clear the taskbar. Twitch's player pillarboxes a vertical stream. The owner's framing (retested,
  2026-10-25): a 1440x1392 preview, the vertical slice shifted 10 % right; the spike now defaults to it (`--landscape` off).
- **A/V sync (2026-10-25):** the owner heard the audio trail the picture. Measured with `--desktop --sync-test` and
  `scripts/av-sync.py` (a flash and a beep every 2 s): audio 376–408 ms late, steady through a run. Trimming 390 ms off the
  audio's start (`lateMs`) gave medians of +19 and −3 ms on two further runs. The product keeps the trim as a setting
  with this default and can re-measure it; the latency is the loopback → AudioWorklet → IPC → pipe path plus ffmpeg's start.
  **Re-measured 2026-10-28 for grab → mux:** `mux` takes PCM only from `grab`'s first video bytes on (ffmpeg's start-up
  drops out) and the worklet posts 1024 samples (~21 ms) instead of 100 ms, so the chunk phase moves the start by at most
  21 ms. Audio was then early: medians 121, 86, 132 ms over three runs (±20 ms within a run, no drift over 60 s). The
  setting became `audioLateMs` (negative = delay the audio, `adelay`), default −110; a check run gave a median of −3 ms
  (−19 to +18). The old `avLateMs` (390) is not read, so a stored value cannot misapply. `av-sync.py`'s −30 dB beep
  threshold missed the beeps at the rig's volume that day (peak −27 dB); −45 found all of them.
  **Again for D1.9** (the grab became a lavfi input, below): two runs at −110 gave medians −30 and −40, so the default
  moved to −145; three check runs gave +40, +8 and +2 ms. Runs differ by up to ~40 ms (the start alignment), more than
  the spread inside one run. The offset is stored only when the player sets their own, so a retuned default reaches
  everyone else.
- **Never stream the desktop (D1.9):** Desktop Duplication films the monitor, not VPX. When VPX loses focus (alt-tab, a
  click elsewhere) the capture keeps running and shows the desktop: the owner's 2026-10-28 run sent a chat window out
  twice (3 s and 14 s). A restart onto the slate would take a second and reconnect the stream, so the grab carries a
  **cover** (a full-frame box in the slate's colour and "Paused: back in a moment") that the engine switches on the fly:
  - a PowerShell helper reports the foreground window's process every change (polled every 25 ms); anything but a
    `VPinballX*` process in front covers at once; VPX back in front uncovers after 750 ms (leaving and re-entering
    exclusive full screen flickers); focus unknown (the helper died) uncovers and logs it;
  - the switch is ffmpeg's interactive `c` command written to the grab's stdin (`c<target> -1 enable 1`, no newline
    after the `c`). Measured 37–144 ms from the write to the first covered frame: ffmpeg reads its keyboard every
    100 ms, and the grab's `-stats_period 0.05` sets how often it looks;
  - **trap:** ffmpeg sends a `c` command to every filtergraph through the graph's inputs. A graph whose only source is
    `ddagrab` inside `-filter_complex` has no inputs, never reads them, and after two commands its queue is full and
    ffmpeg's command reading blocks for the rest of the run (the cover stuck on, 8.1.1). So the grab takes `ddagrab`
    as a lavfi input (`-f lavfi -i ddagrab=…,hwdownload,format=bgra`) and runs one graph after it: 16 of 16 commands
    applied, and the grab as smooth (273 new frames in 5 s of 300; 275 before);
  - the MP4 is covered too, and the manifest gets `cover_start` (with what was in front) / `cover_end`, so a reviewer
    sees why a stretch shows no table. What is in front of VPX on the same monitor while VPX keeps focus (an
    always-on-top window) is not covered.
- **Stream key** encrypted with Electron `safeStorage`, never sent to ArcAid, never logged.

## 4. Build order (each step ships alone)

| Step | What |
|---|---|
| **D1.0** spike | On the owner's rig: loopback audio from Electron piped into ffmpeg; `ddagrab` cropped to the VPX window (DPI, monitor index); overlay text refreshed live (`drawtext` `reload`); a two-minute RTMP push to a Twitch test channel; frame cost read with the F11 overlay, desktop and VR with `VRPreview` on. Output: the exact ffmpeg graph and any change to this plan. |
| **D1.1** OBS overlay | A local page on 127.0.0.1 with live score, ball, player and badge from the witness (server-sent events). No capture involved. Built: `http://127.0.0.1:47390/overlay` (fixed port so the OBS source survives restarts), `/events` (SSE, coalesced 100 ms, sent only on change), `/state.json`; the witness's `game` event (`LiveGame`) is the data D1.4 burns in. |
| **D1.2** recording | MP4 per session with game start / end markers; a hash-chained manifest (file sha256, previous entry, the score each game posted); retention per §2. Built 2026-10-28 (`media/recording.ts`): a session folder holds `seg-NNN.mp4`, one per capture run (a table, or a restart after a loss), and `manifest.jsonl` whose every line carries the sha256 of the line before; a closed segment's line holds the MP4's sha256; game start / end and each posted score name the segment recording. Retention keeps the newest N sessions plus an optional MP4 cap; Sanctioned sessions are kept, but nothing marks a score Sanctioned yet (D1.7). A stop ends the grab and lets the mux process finish the file, so nothing is lost (D1.8). Shipped 0.2.19. |
| **D1.3** streaming | Twitch / YouTube ingest, key in `safeStorage`, bitrate presets, reconnect with backoff, health (bitrate, dropped frames). Built 2026-10-28 (`media/stream-engine.ts`, `media/stream-settings.ts`, `main/stream-host.ts`): probes every 2 s; a player window steady for two probes is captured (since 0.2.19 two processes, grab → mux, see §3; the mux tees segment + push); window gone or moved stops it; no window while live = a "back in a moment" slate (push only, never recorded); a run that dies or a push that drops (tee's "Slave muxer failed") restarts after 1, 2, 4 … 30 s. Key in `stream.json` through the token codec. Controls: Settings → Stream and record, and the tray. Health is fps and speed (bitrate shows N/A through tee). Shipped 0.2.19. |
| **D1.9** cover | Whenever VPX is not the window in front, the picture is covered ("Paused: back in a moment") inside the running capture; see §3 "Never stream the desktop". Shipped 0.2.19. |
| **D1.4** burned-in overlay | Built: the engine renders the D1.1 overlay state (table, scores, player up, ball, attempt, last post, badge) to text and ffmpeg's `drawtext` (`reload=1`) draws it bottom-left in the capture from `stream-overlay.txt`, which the engine overwrites in place (never by rename) when the text changes; on by default, a Stream setting turns it off for streamers who use the OBS page instead. |
| **D1.5** Stream page | Go live, record, preview, health, settings (quality, retention, microphone). |

ArcAid is not needed until a later step sends the recording's hash with the score.

## 5. D1.0 runbook (owner's rig, ~20 minutes)

Done without VPX on 2026-10-25 (`--desktop`): DXGI outputs found (two 2560x1440, by monitor handle), Electron loopback
audio flowing ("System audio" track, a 5 s test tone recorded whole with no dropouts), overlay redrawn live, 240/240
frames at 720p30 NVENC, audio and video of equal length. What needs the rig:

1. `git pull`, then `npm ci` at the repo root (once).
2. Open Monster Bash in VPX (the desktop build, fullscreen, or windowed with the taskbar hidden: the capture films
   whatever is on screen over the window) and start a game.
   **Preview first:** `npm run spike:stream -w companion -- --preview` shows exactly what the stream would carry (same
   crop, scale and overlay) in an ffplay window on the other monitor, with nothing recorded or sent. Adjust
   `--portrait N` (slice shift in % of the window width, + = right; default 10, tuned for VR's left-eye preview; try 0
   on desktop) or `--landscape` until it looks right, close it (Q or the X), and it prints the command to go live with
   the same framing. ffplay ships with ffmpeg (owner ask 2026-10-27: a preview before going live, an existing tool
   preferred).
3. In another terminal at the repo root: `npm run spike:stream -w companion -- --seconds 120`. Keep playing. Read the FPS on
   VPX's F11 overlay once before you start the command and once while it runs.
4. Paste back the `D1.0 | …` line with the two FPS numbers filled in, and open the MP4 it names (under `tmp/d1-spike/`):
   is the playfield framed right (no title bar, nothing cut), is the table sound there, is the overlay readable?
   The spike opens the folder holding the MP4 when it ends. F11 is VPX's own frame counter (desktop build); it is optional.
5. **Stream test:** copy the stream key from Twitch (Creator Dashboard → Settings → Stream → Primary Stream key). For a
   private test, append `?bandwidthtest=true` to the key: Twitch accepts the stream but does not broadcast it, and
   inspector.twitch.tv shows its bitrate, frame rate and keyframe interval. Without it, the channel goes live. In
   PowerShell: `$env:CASTCADE_RTMP_URL = 'rtmp://live.twitch.tv/app/<key>?bandwidthtest=true'`, run step 3 again, then
   `Remove-Item Env:CASTCADE_RTMP_URL`. The key is never printed.
6. **VR (optional):** close VPX (it rewrites the ini on exit), set `VRPreview = 1` in the `VPinballX.ini` beside the exe,
   play in the headset, run step 3. Without this, a VR game records black. The recording is only as sharp as the preview
   window: set `PreviewWidth = 1280` and `PreviewHeight = 720` (or 1920 / 1080 with `--preset 1080p30`) in the same section.
7. **Commentary (optional):** add `--mic` to the command (`... -- --seconds 120 --mic`) and talk while it runs. The spike
   lists the microphones it sees; `--mic "Focusrite"` picks the first whose name contains that text.

**Result (owner's rig, 2026-10-27): passed.** Desktop VPX 10.8.0 in cabinet mode (`BGSet = 1`) on a landscape monitor
standing portrait, `--rotate 90 --portrait 0` (§3 "VPX cabinet mode"), NVENC:

| Run | Picture | Frames | VPX F11 |
|---|---|---|---|
| 720p30, live on Twitch | 720x1280, 4.6 Mbps, upright, overlay on | 3600 / 3600 | ~450-460 fps, 0.5-0.7 ms, the same without capture |
| 1080p30, live | 1080x1920, 6.2 Mbps | 3234 until the player quit at 108 s, none dropped | ~350-420 fps, 0.7 ms |
| 720p30 `--bundled`, live (the installer's ffmpeg, D1.6) | 720x1280, 4.7 Mbps, same picture | 2339 until the player quit at 78 s, none dropped | same as the first run |

Both short runs ended when the owner quit to the table editor (Esc → Quit to editor): the full-screen player window
closes, Desktop Duplication is lost and `ddagrab` stops ffmpeg with `Generic error in an external library`. Expected,
and it shapes the product: a stream session outlives one table. When the player window goes, the companion keeps the
stream up on a standby slate, ends the MP4 segment, and restarts the capture on the next player window (D1.3); any other
loss of Desktop Duplication (a secure-desktop prompt) takes the same path. Alt-tab does **not** lose it: on the owner's
rig (2026-10-28) focus moving off VPX kept the capture running and the stream showed the desktop and a chat window. D1.9
covers the stream whenever the player window is not in front. The spike
now writes ffmpeg's whole log beside the MP4 (the summary's last five lines had dropped `ddagrab`'s own line).

Earlier the same day: a `?bandwidthtest=true` push (stable 4,497 kbps, config Excellent); a windowed player showed the
taskbar and the VR-tuned +10 % slice cut the table (hence `--preview`); a Windows-rotated portrait monitor came in on
its side (hence `ddagrab` rotation handling). Changes to this plan: none to architecture A; the Stream page gains the
preview and a Rotate setting (D1.5). Not run: VR with `VRPreview` and the microphone (optional; desktop VR players are
D6's guided-setup check).
