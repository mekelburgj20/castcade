"""Measure how far the audio trails the picture in a `stream-spike.mjs --desktop --sync-test` recording.

    python companion/scripts/av-sync.py <recording.mp4>

Finds each white flash (mean luma of the top-left corner jumps) and each beep (audio level jumps), pairs them, and
prints the offsets: positive = the audio is late. Needs ffmpeg on PATH; standard library only.
"""
import re
import subprocess
import sys


def flashes(path: str) -> list[float]:
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-i', path, '-vf', 'crop=200:100:20:20,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'],
        capture_output=True, text=True,
    ).stderr
    times, prev = [], 0.0
    t = None
    for line in out.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            t = float(m.group(1))
        m = re.search(r'YAVG=([\d.]+)', line)
        if m and t is not None:
            y = float(m.group(1))
            if y > 128 and prev <= 128:
                times.append(t)
            prev = y
    return times


def beeps(path: str) -> list[float]:
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-i', path, '-vn', '-af', 'bandpass=f=1000:width_type=q:w=4,astats=metadata=1:reset=1:length=0.005,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'],
        capture_output=True, text=True,
    ).stderr
    times, prev = [], -200.0
    t = None
    for line in out.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            t = float(m.group(1))
        m = re.search(r'RMS_level=(-?[\d.]+|-inf)', line)
        if m and t is not None:
            v = -200.0 if m.group(1) == '-inf' else float(m.group(1))
            if v > -30 and prev <= -30:
                times.append(t)
            prev = v
    return times


def main() -> None:
    path = sys.argv[1]
    f, b = flashes(path), beeps(path)
    print(f'flashes {len(f)}, beeps {len(b)}')
    offsets = []
    for ft in f:
        near = [bt - ft for bt in b if -1.0 < bt - ft < 1.0]
        if near:
            offsets.append(min(near, key=abs))
    if not offsets:
        print('no flash/beep pairs found')
        return
    ms = sorted(round(o * 1000) for o in offsets)
    print('audio late by (ms):', ms)
    print('median:', ms[len(ms) // 2])


if __name__ == '__main__':
    main()
