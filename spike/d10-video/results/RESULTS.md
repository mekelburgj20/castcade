# D10.0.1 results

Protocol: 25000:30,2000:20,25000:40 (kbps:s), target 1354x1440 at 60 fps; reduced by measure.mjs. One row per run, newest last.

| run | candidate | encoder | fps held (p1 median / min) | kbps p1 / p2 / p3 | longest freeze after drop | settle after drop | recover after restore | fps p2 / p3 | enc µs | exe MB | LOC | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-07T05:56 | str0m | h264_nvenc | 60 / 59 | 19986 / 1421 / 12525 | 3035 ms | 7 s | 21 s | 63 / 60 | 9214 | 6.1 | 1426 | run 1, GPU idle |
| 2026-11-07T06:01 | libwebrtc | h264_nvenc | 60 / 58 | 18447 / 1925 / 7660 | 1848 ms | 4 s | 33 s | 60 / 60 | 8335 | 18.0 | 1767 | run 1, GPU idle |
| 2026-11-07T06:04 | str0m | h264_nvenc | 60 / 59 | 19987 / 1423 / 13305 | 5132 ms | 8 s | 18 s | 61 / 60 | 9579 | 6.1 | 1426 | run 2, GPU idle |
| 2026-11-07T06:05 | libwebrtc | h264_nvenc | 60 / 58 | 18362 / 1943 / 9087 | 1816 ms | 3 s | 30 s | 58 / 60 | 9341 | 18.0 | 1767 | run 2, GPU idle |
| 2026-11-07T06:09 | gstreamer | nvh264enc | 60 / 7 | 15479 / 1288 / 5773 | 986 ms | 2 s | — s | 60 / 60 | 13473 | 0.4 | 860 | run 1, GPU idle |
| 2026-11-07T06:11 | gstreamer | nvh264enc | 60 / 13 | 14729 / 1542 / 5645 | 1561 ms | 2 s | — s | 60 / 60 | 12584 | 0.4 | 860 | run 2, GPU idle |
