#!/usr/bin/env python3
"""tail-journal.py -- read a Castcade journal, decode it, and judge the Phase 0 gates.

    python tail-journal.py <table-id or path.jsonl> [--follow] [--rom ROM] [--offset N]
                           [--maps DIR] [--parser DIR] [--nvram-dir DIR] [--quiet-scores]

For VPM tables (recipe A) it rebuilds a shadow NVRAM from `nvram_full` + `nvram_delta`, decodes the
`game_state` block with the pinmame-nvram-maps map for the ROM named in `table_loaded`, and runs the
ball-end detector (a pure function over successive game states).  For originals (recipes B/C/E) it
prints the script events directly.  Lock, key_blocked, warn and table_exit lines are always shown.

At end of file (or Ctrl-C in --follow mode) it prints a summary against the Phase 0 gates:
  0a  VPM:   ball 1 -> 2 -> 3 and a game_end seen live
  0b  orig:  current_scores climbing, ball_end and game_end seen
  0c  lock:  key_blocked lines while locked (flippers dead inside the script)
  0e  sidecar auto-load: table_loaded present at all

This is spike tooling.  The detector logic is the seed of the Phase 3 companion detector and of the
fixtures/ replay tests; nothing here is production code.
"""
import argparse
import gzip
import json
import os
import sys
import time
import types

DEFAULT_PARSER = r"C:\code\repos\ArcAid\tmp\vpx-desktop-witness\py-pinmame-nvmaps"
DEFAULT_MAPS = r"C:\code\repos\ArcAid\tmp\vpx-desktop-witness\pinmame-nvram-maps"
DEFAULT_NVRAM_DIR = r"C:\Users\mekel\Documents\Emulators\VPX\VisualPinballX\vpinmame\nvram"


# ----------------------------------------------------------------------------- map decode --

def load_parser(parser_dir):
    # nvram_parser imports curses.ascii, which Windows Python lacks; shim it.
    curses = types.ModuleType("curses")
    asc = types.ModuleType("curses.ascii")
    asc.isprint = lambda c: 32 <= (c if isinstance(c, int) else ord(c)) < 127
    curses.ascii = asc
    sys.modules["curses"] = curses
    sys.modules["curses.ascii"] = asc
    sys.path.insert(0, parser_dir)
    import nvram_parser  # noqa: E402
    return nvram_parser


class MapDecoder:
    def __init__(self, rom, maps_dir, parser_dir):
        self.rom = rom
        self.ok = False
        self.reason = ""
        try:
            self.np = load_parser(parser_dir)
            self.np.MAPS_ROOT = maps_dir
            index = json.load(open(os.path.join(maps_dir, "index.json")))
            entry = index.get(rom)
            if entry is None:
                self.reason = "rom %s not in maps index" % rom
                return
            rel = entry if isinstance(entry, str) else entry.get("path") or entry.get("map")
            self.map_json = json.load(open(os.path.join(maps_dir, rel)))
            self.map_path = rel
            if "game_state" not in self.map_json:
                self.reason = "map %s has no game_state block (scores only at exit)" % rel
                return
            self.ok = True
        except Exception as ex:  # pragma: no cover
            self.reason = "decoder unavailable: %r" % ex

    def decode(self, buf):
        """game_state as plain values: scores[list], current_player, current_ball, game_over(bool),
        player_count, extra_balls, ball_count.  Missing keys -> None."""
        p = self.np.ParseNVRAM(self.map_json, bytearray(buf))
        out = {"scores": []}
        for e in p.mapping:
            if e.section != "game_state":
                continue
            try:
                v = e.get_value(p.memory)
            except Exception:
                v = None
            if e.key == "scores":
                out["scores"].append(v)
            elif e.key == "game_over":
                out["game_over"] = bool(v) if v is not None else None
            else:
                out[e.key] = v
        return out


# ----------------------------------------------------------------------------- detector ---

def plausible(st):
    """Reject decoded states that cannot be a real game: player/ball out of range, scores not ints.
    Seen on the owner's rig 2026-10-17: Medieval Madness boots with NVRAM filled 0x55 then 0xAA for
    ~10 s (current_player=85/170), which produced a fake game_start/ball_end/game_end."""
    if st is None:
        return False
    p, b = st.get("current_player"), st.get("current_ball")
    if p is not None and not (0 <= p <= 4):
        return False
    bc = st.get("ball_count") or 5
    if b is not None and not (0 <= b <= max(bc, 5) + 4):
        return False
    if st.get("player_count") is not None and not (0 <= st["player_count"] <= 4):
        return False
    for sc in st.get("scores") or []:
        if sc is not None and (not isinstance(sc, int) or sc < 0 or sc > 10**12):
            return False
    return True


def detect(prev, cur):
    """Pure function: events implied by going from game_state `prev` to `cur`.
    Returns a list of (name, dict).  Rules:
      game_over True->False                      -> game_start
      active and (ball up or player changed)    -> ball_end for the previous (player, ball)
      game_over False->True (with a ball in play) -> ball_end for the last ball, then game_end
      scores changed                             -> current_scores
    An extra ball (extra_balls decrements, ball and player unchanged) fires nothing: the turn goes on.
    A state that is not plausible() (ROM boot RAM test, 0x55/0xAA fills) fires nothing and is not kept as prev."""
    ev = []
    if prev is None or not plausible(cur):
        return ev
    pgo, cgo = prev.get("game_over"), cur.get("game_over")
    if pgo is True and cgo is False:
        ev.append(("game_start", {"players": cur.get("player_count")}))
    if pgo is False:
        pb, cb = prev.get("current_ball"), cur.get("current_ball")
        pp, cp = prev.get("current_player"), cur.get("current_player")
        had_ball = pb is not None and pb >= 1          # ball 0 (DE/WPC between games) never "ends"
        if cgo is False and had_ball and ((cb is not None and cb > pb) or (cp is not None and pp is not None and cp != pp)):
            ev.append(("ball_end", {"player": pp, "ball": pb, "extra_balls": prev.get("extra_balls")}))
        if cgo is True and had_ball:     # a game that never had a ball in play (ROM boot settling) did not end
            ev.append(("ball_end", {"player": pp, "ball": pb, "extra_balls": prev.get("extra_balls")}))
            ev.append(("game_end", {"scores": cur.get("scores"), "players": prev.get("player_count")}))
    if prev.get("scores") != cur.get("scores"):
        ev.append(("current_scores", {"scores": cur.get("scores"), "player": cur.get("current_player"), "ball": cur.get("current_ball")}))
    return ev


# ----------------------------------------------------------------------------- alignment --

def alignment(live, disk):
    """Best offset k such that disk[k:] lines up with live (k may be negative). Returns (k, agreement)."""
    best = None
    span = abs(len(disk) - len(live)) + 16
    for k in range(-span, span + 1):
        if k >= 0:
            a, b = disk[k:], live
        else:
            a, b = disk, live[-k:]
        n = min(len(a), len(b))
        if n < 64:
            continue
        idx = range(0, n, 3)
        same = sum(1 for i in idx if a[i] == b[i])
        score = same / len(idx)
        if best is None or score > best[1]:
            best = (k, score)
    return best or (0, 0.0)


# ----------------------------------------------------------------------------- session ----

class Session:
    def __init__(self, args, loaded):
        self.args = args
        self.table = loaded.get("table")
        self.recipe = loaded.get("recipe")
        self.rom = args.rom or loaded.get("rom") or ""
        self.lib = loaded.get("lib")
        self.started = loaded.get("session")
        self.shadow = None
        self.offset = args.offset
        self.decoder = None
        self.state = None
        # A ball or game end needs a game_start seen this session: Monster Bash's boot (2026-10-23)
        # wrote player 1 / ball 1 and game over in two callbacks, which "ended" the last game again.
        self.in_game = False
        self.counts = {}
        self.balls_seen = set()
        self.max_ball = 0
        self.lock_events = 0
        self.blocked = 0
        self.warns = []
        self.exit = None
        self.hook = None
        self.disk_len = None
        self.align = None
        if self.recipe == "A" and self.rom:
            self.decoder = MapDecoder(self.rom, args.maps, args.parser)
            if not self.decoder.ok:
                print("   ! %s" % self.decoder.reason)
        print("== table_loaded  %s  recipe=%s rom=%s lib=%s session=%s locked=%s" % (
            self.table, self.recipe, self.rom or "-", self.lib, self.started, loaded.get("locked")))

    def bump(self, k):
        self.counts[k] = self.counts.get(k, 0) + 1

    def show(self, t, name, d):
        if name == "current_scores" and self.args.quiet_scores:
            return
        print("   t=%9.3f  %-14s %s" % (float(t), name, json.dumps(d)))

    def handle(self, e):
        ev = e.get("event")
        t = e.get("t", 0)
        self.bump(ev)
        if ev == "nvram_hook":
            self.hook = e
            print("   t=%9.3f  nvram_hook     chained=%s use_nvram=%s" % (float(t), e.get("chained"), e.get("use_nvram")))
        elif ev == "nvram_full":
            self.shadow = bytearray(int(x) & 0xFF for x in e["bytes"])
            print("   t=%9.3f  nvram_full     live NVRAM length %d" % (float(t), len(self.shadow)))
            if self.decoder and self.decoder.ok:
                self.check_alignment()
                self.state = self.decode()
                print("   initial game_state: %s%s" % (json.dumps(self.state), "" if plausible(self.state) else "  (implausible: ROM boot pattern, ignored)"))
                if not plausible(self.state):
                    self.state = None
        elif ev == "nvram_delta":
            if self.shadow is None:
                return
            for off, new, _old in e["d"]:
                if 0 <= off < len(self.shadow):
                    self.shadow[off] = int(new) & 0xFF
            if self.decoder and self.decoder.ok:
                cur = self.decode()
                for name, d in detect(self.state, cur):
                    if name in ("ball_end", "game_end") and not self.in_game:
                        continue
                    if name in ("game_start", "game_end"):
                        self.in_game = name == "game_start"
                    self.bump("derived:" + name)
                    if name == "ball_end" and d.get("ball") is not None:
                        self.balls_seen.add(d["ball"])
                        self.max_ball = max(self.max_ball, d["ball"] or 0)
                    self.show(t, name, d)
                if not plausible(cur):
                    return
                if cur.get("current_ball"):
                    self.max_ball = max(self.max_ball, cur["current_ball"])
                self.state = cur
        elif ev in ("game_start", "current_scores", "ball_end", "game_end"):
            if ev == "ball_end":
                self.balls_seen.add(e.get("ball"))
                self.max_ball = max(self.max_ball, e.get("ball") or 0)
            self.show(t, ev, {k: v for k, v in e.items() if k not in ("event", "t")})
        elif ev == "lock":
            self.lock_events += 1
            print("   t=%9.3f  lock           locked=%s" % (float(t), e.get("locked")))
        elif ev == "key_blocked":
            self.blocked += 1
            print("   t=%9.3f  key_blocked    key=%s" % (float(t), e.get("key")))
        elif ev == "warn":
            self.warns.append(e)
            print("   t=%9.3f  WARN           %s %s" % (float(t), e.get("msg"), e.get("err", "")))
        elif ev == "table_exit":
            self.exit = e
            print("   t=%9.3f  table_exit     lines=%s nvram_callbacks=%s blocked_keys=%s" % (
                float(t), e.get("lines"), e.get("nvram_callbacks"), e.get("blocked_keys")))
        else:
            self.show(t, ev, {k: v for k, v in e.items() if k not in ("event", "t")})

    def check_alignment(self):
        nv = os.path.join(self.args.nvram_dir, self.rom + ".nv")
        if not os.path.exists(nv):
            print("   (no on-disk %s.nv to compare against; using --offset %d)" % (self.rom, self.offset))
            return
        disk = bytearray(open(nv, "rb").read())
        self.disk_len = len(disk)
        k, agree = alignment(self.shadow, disk)
        self.align = (k, agree)
        verdict = "SAME INDEXING" if k == 0 and agree > 0.5 else ("SHIFT %+d" % k if agree > 0.5 else "NO MATCH")
        print("   alignment: on-disk .nv %d bytes vs live %d; best offset %+d at %.1f%% agreement -> %s" % (
            len(disk), len(self.shadow), k, agree * 100, verdict))
        if self.args.offset == 0 and agree > 0.5 and k != 0:
            print("   applying offset %+d for decoding (override with --offset)" % k)
            self.offset = k

    def decode(self):
        k = self.offset
        if k >= 0:
            buf = bytearray(k) + self.shadow
        else:
            buf = self.shadow[-k:]
        return self.decoder.decode(buf)

    def summary(self):
        c = self.counts
        print("\n== summary for %s (recipe %s, rom %s)" % (self.table, self.recipe, self.rom or "-"))
        for k in sorted(c):
            print("   %-24s %d" % (k, c[k]))
        print("   balls seen ending: %s   max ball: %d" % (sorted(b for b in self.balls_seen if b is not None), self.max_ball))
        if self.align:
            print("   live/disk alignment: offset %+d, %.1f%% agreement" % (self.align[0], self.align[1] * 100))
        print("\n== Phase 0 gates")
        print("   0e sidecar auto-load : PASS (table_loaded seen, lib %s)" % self.lib)
        if self.recipe == "A":
            if self.decoder is None or not self.decoder.ok:
                print("   0a live NVRAM        : UNDECIDED (%s)" % (self.decoder.reason if self.decoder else "no rom"))
            else:
                be = c.get("derived:ball_end", 0)
                ge = c.get("derived:game_end", 0)
                ok = be >= 3 and ge >= 1 and {1, 2, 3} <= {b for b in self.balls_seen if b}
                print("   0a live NVRAM        : %s (nvram_full=%d deltas=%d ball_end=%d game_end=%d; need balls 1,2,3 + game_end)" % (
                    "PASS" if ok else "FAIL", c.get("nvram_full", 0), c.get("nvram_delta", 0), be, ge))
                if c.get("nvram_delta", 0) == 0:
                    print("      no deltas at all: UseVPMNVRAM did not reach core.vbs, or UseNVRAM is False (see nvram_hook use_nvram)")
        else:
            cs = c.get("current_scores", 0)
            ok = cs >= 2 and c.get("ball_end", 0) >= 1 and c.get("game_end", 0) >= 1
            print("   0b original scoring  : %s (game_start=%d current_scores=%d ball_end=%d game_end=%d)" % (
                "PASS" if ok else "FAIL", c.get("game_start", 0), cs, c.get("ball_end", 0), c.get("game_end", 0)))
        if self.blocked:
            print("   0c script turn lock  : ENGAGED %d times (%d lock transitions). PASS if the flippers did nothing while locked." % (self.blocked, self.lock_events))
        else:
            print("   0c script turn lock  : NOT EXERCISED (no key_blocked). Run lock.ps1 cycle and press flippers while locked.")
        if self.warns:
            print("   warnings: %d (see above)" % len(self.warns))
        if self.exit is None:
            print("   (no table_exit: table still running, or VPX was killed)")


# ----------------------------------------------------------------------------- reader -----

def resolve(arg):
    if arg.lower().endswith(".jsonl") or os.sep in arg or "/" in arg:
        return arg
    safe = "".join(c if (c.isalnum() or c in "._-") else ("_" if c == " " else "") for c in arg)
    return os.path.join(os.environ.get("LOCALAPPDATA", "."), "Castcade", "journal", safe + ".jsonl")


def read_lines(path, follow):
    """Yield complete lines; in follow mode keep polling and tolerate a torn last line."""
    buf = b""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if chunk:
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    yield line
                continue
            if not follow:
                if buf.strip():
                    yield buf
                return
            time.sleep(0.25)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("journal", help="table id (as in table_loaded) or a .jsonl path")
    ap.add_argument("--follow", "-f", action="store_true")
    ap.add_argument("--rom", default=None, help="override the ROM named in table_loaded")
    ap.add_argument("--offset", type=int, default=0, help="live index -> .nv offset shift (auto from alignment when 0)")
    ap.add_argument("--maps", default=os.environ.get("CASTCADE_MAPS", DEFAULT_MAPS))
    ap.add_argument("--parser", default=os.environ.get("CASTCADE_NVPARSER", DEFAULT_PARSER))
    ap.add_argument("--nvram-dir", default=os.environ.get("CASTCADE_NVRAM_DIR", DEFAULT_NVRAM_DIR))
    ap.add_argument("--quiet-scores", action="store_true", help="do not print every current_scores line")
    ap.add_argument("--last", action="store_true", help="only report the last session in the file")
    args = ap.parse_args()

    path = resolve(args.journal)
    if not os.path.exists(path):
        print("journal not found: %s" % path)
        sys.exit(1)
    print("reading %s%s" % (path, " (follow)" if args.follow else ""))

    if args.last:
        raw = (gzip.open if path.endswith(".gz") else open)(path, "rb").read().split(b"\n")
        starts = [i for i, l in enumerate(raw) if b'"event":"table_loaded"' in l]
        if starts:
            raw = raw[starts[-1]:]
        lines = iter(raw)
    else:
        lines = read_lines(path, args.follow)

    session = None
    torn = 0
    try:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                torn += 1
                continue
            if e.get("event") == "table_loaded":
                if session:
                    session.summary()
                session = Session(args, e)
                continue
            if session is None:
                continue
            session.handle(e)
    except KeyboardInterrupt:
        print("\n(stopped)")
    if session:
        session.summary()
    else:
        print("no table_loaded in journal: the sidecar did not run (0e FAIL) or the library is missing "
              "(check %%TEMP%%\\castcade-sidecar-ran-but-no-library.txt)")
    if torn:
        print("   (%d unparseable line(s) skipped; a torn last line is normal if VPX was killed)" % torn)


if __name__ == "__main__":
    main()
