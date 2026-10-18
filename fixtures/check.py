#!/usr/bin/env python3
"""check.py -- replay every fixture through the Phase 0 decoder/detector and assert the outcome.

    python fixtures/check.py            (CASTCADE_MAPS and CASTCADE_NVPARSER must point at the
                                         pinmame-nvram-maps and py-pinmame-nvmaps clones)

For each `fixtures/**/*.jsonl` or `*.jsonl.gz` with a sibling `<name>.meta.json`, runs
`vpx-hook/spike/tail-journal.py --quiet-scores` and checks its summary against the meta:

    game_start == games        ball_end == balls_per_game * games (default 3)
    game_end   == games        balls seen ending == [1 .. balls_per_game]

Recipe A (VPM) fixtures report `derived:*` counts (detector output); script recipes report the raw
script events. CASTCADE_NVRAM_DIR is pointed at an empty temp dir so the alignment step prints its
"no on-disk .nv" line instead of reading the owner's live NVRAM. Prints one PASS/FAIL line per
fixture; exit 1 on any failure. Stdlib only, Python 3.12+.
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TAILER = os.path.join(ROOT, "vpx-hook", "spike", "tail-journal.py")

COUNT_LINE = re.compile(r"^\s+(\S+)\s+(\d+)\s*$")
BALLS_LINE = re.compile(r"^\s+balls seen ending: (\[[^\]]*\])")


def fixtures():
    pats = [os.path.join(HERE, "**", "*.jsonl"), os.path.join(HERE, "**", "*.jsonl.gz")]
    for pat in pats:
        for path in sorted(glob.glob(pat, recursive=True)):
            base = path[: -len(".jsonl.gz")] if path.endswith(".jsonl.gz") else path[: -len(".jsonl")]
            meta = base + ".meta.json"
            if os.path.exists(meta):
                yield path, meta


def parse_summary(text):
    """Counts (summed over every `== summary` block) and the union of balls seen ending."""
    counts, balls, in_summary = {}, set(), False
    for line in text.splitlines():
        if line.startswith("== summary"):
            in_summary = True
            continue
        if line.startswith("== "):
            in_summary = False
        if not in_summary:
            continue
        m = BALLS_LINE.match(line)
        if m:
            balls.update(json.loads(m.group(1)))
            continue
        m = COUNT_LINE.match(line)
        if m:
            counts[m.group(1)] = counts.get(m.group(1), 0) + int(m.group(2))
    return counts, balls


def check(path, meta, nvram_dir):
    rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
    games = int(meta.get("games", 1))
    per_game = int(meta.get("balls_per_game", 3))
    prefix = "derived:" if meta.get("recipe") == "A" else ""

    env = dict(os.environ, CASTCADE_NVRAM_DIR=nvram_dir)
    proc = subprocess.run(
        [sys.executable, TAILER, path, "--quiet-scores"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )
    if proc.returncode != 0:
        print("FAIL %s: tail-journal.py exited %d\n%s" % (rel, proc.returncode, proc.stdout + proc.stderr))
        return False

    counts, balls = parse_summary(proc.stdout)
    got = {
        "game_start": counts.get(prefix + "game_start", 0),
        "ball_end": counts.get(prefix + "ball_end", 0),
        "game_end": counts.get(prefix + "game_end", 0),
        "balls": sorted(b for b in balls if b is not None),
    }
    want = {
        "game_start": games,
        "ball_end": per_game * games,
        "game_end": games,
        "balls": list(range(1, per_game + 1)),
    }
    problems = ["%s=%r (want %r)" % (k, got[k], want[k]) for k in want if got[k] != want[k]]
    if "nvram_full" in counts and "no on-disk" not in proc.stdout and "alignment:" in proc.stdout:
        problems.append("alignment ran against an on-disk .nv; CASTCADE_NVRAM_DIR should be empty")
    detail = "games=%d ball_end=%d game_end=%d game_start=%d balls=%s" % (
        games, got["ball_end"], got["game_end"], got["game_start"], got["balls"])
    if problems:
        print("FAIL %s: %s  [%s]" % (rel, "; ".join(problems), detail))
        return False
    print("PASS %s  [%s]" % (rel, detail))
    return True


def main():
    for var in ("CASTCADE_MAPS", "CASTCADE_NVPARSER"):
        if not os.path.isdir(os.environ.get(var, "")):
            print("%s is not set to a directory (pinmame-nvram-maps / py-pinmame-nvmaps clone)" % var)
            return 2
    found = list(fixtures())
    if not found:
        print("no fixtures with a .meta.json under %s" % HERE)
        return 2
    failures = 0
    with tempfile.TemporaryDirectory(prefix="castcade-empty-nvram-") as nvram_dir:
        for path, meta_path in found:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
            if not check(path, meta, nvram_dir):
                failures += 1
    print("%d fixture(s), %d failed" % (len(found), failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
