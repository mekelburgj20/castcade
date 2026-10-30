# Source for the bundled ffmpeg (GPLv3)

Castcade's installer carries `ffmpeg.exe` and `ffplay.exe` for streaming, recording and the framing preview
(D1.6, `docs/design/solo-streaming-and-recording.md`). They are not built by this project. This page names exactly
what is bundled and says where the GPLv3 Corresponding Source is. Work item E5.

## What is bundled

| | |
|---|---|
| Build | Gyan Doshi's "essentials" Windows build, `ffmpeg-8.1.1-essentials_build` (www.gyan.dev) |
| Version | 8.1.1 |
| Zip sha256 | `6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541` |
| FFmpeg commit | `239f2c733d` (the `Source Code:` line of the build's `README.txt`) |
| Licence | GPL v3 (static build, no `--enable-nonfree`); full text in the `LICENSE` file beside the binaries |
| Where it sits | `resources/ffmpeg/` in the install: `ffmpeg.exe`, `ffplay.exe`, `LICENSE`, `README.txt`, `SOURCE-OFFER.txt`, `VERSION` |

## Written offer (GPLv3 section 6(b))

For three years from the date of each Castcade release, anyone who holds that release's installer may obtain, free
of charge beyond the cost of transferring it, the Corresponding Source of the ffmpeg bundled in it:

- It is published with every GitHub release of Castcade (https://github.com/mekelburgj20/castcade/releases) as
  `ffmpeg-<version>-source.tar.gz` (FFmpeg at the commit above) and `ffmpeg-<version>-SOURCES.txt` (the library
  list below).
- It is also available on request: open an issue at https://github.com/mekelburgj20/castcade/issues.

The release assets are also the section 6(d) route: the source is offered from the same place as the installer.
The same offer ships inside the install as `resources/ffmpeg/SOURCE-OFFER.txt`.

## Statically linked libraries

Copied verbatim from the build's `README.txt` ("external libraries' versions"). Each library's source is the
upstream release at that version; this page gives no URLs because the README gives none.

| Library as listed | Upstream project |
|---|---|
| AMF v1.5.0-1-gd0b3e6d | AMF (AMD Advanced Media Framework) |
| aom v3.13.3-431-ge86de95f79 | aom (AV1 codec library) |
| AviSynthPlus v3.7.5-281-g23f0e3fa | AviSynth+ |
| cairo 1.18.5 | cairo |
| ffnvcodec n13.0.19.0-3-g33a9ede | ffnvcodec (nv-codec-headers) |
| gsm 1.0.24 | gsm |
| lame 3.100 | LAME |
| libgme 0.6.6 | Game Music Emu (libgme) |
| libopencore-amrnb 0.1.6 | OpenCORE AMR (libopencore-amrnb) |
| libopencore-amrwb 0.1.6 | OpenCORE AMR (libopencore-amrwb) |
| libssh 0.12.0 | libssh |
| libtheora v1.2.0 | libtheora |
| libwebp v1.6.0-175-g24f7331 | libwebp |
| openal-soft latest | OpenAL Soft |
| openmpt libopenmpt-0.6.28-14-gd0e05aa3 | libopenmpt |
| opus v1.6.1-19-gf8f99516 | Opus |
| rubberband v1.8.1 | Rubber Band |
| SDL release-2.32.0-198-g039a60c52 | SDL |
| speex Speex-1.2.1-51-g0589522 | Speex |
| srt v1.5.5 | SRT |
| VAAPI 2.24.0. | VA-API |
| vidstab v1.1.1-24-g92bc0b0 | vid.stab |
| vmaf v3.1.0-33-g151a9822 | VMAF |
| vo-amrwbenc 0.1.3 | vo-amrwbenc |
| vorbis v1.3.7-24-g68a7fc22 | Vorbis |
| VPL 2.16 | VPL |
| vpx v1.16.0-108-g640d4ce27 | vpx (libvpx) |
| x264 v0.165.3223 | x264 |
| x265 4.2-4-g3f4120d | x265 |
| xvid v1.3.7 | Xvid |
| zeromq 4.3.5 | ZeroMQ |
| zimg release-3.0.6-218-gfa52dee | zimg |

## Moving the pin

Change `VERSION` and `SHA256` in `companion/scripts/fetch-ffmpeg.mjs` (its header lists what to re-check), then
update the table above from the new build's `README.txt`. `npm run ffmpeg-source -w companion` reads the commit
and library list from that same file, so the release assets follow the pin on their own.
