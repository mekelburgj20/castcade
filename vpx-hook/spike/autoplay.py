#!/usr/bin/env python3
"""autoplay.py - drive a staged VPX table with synthesized key presses (Phase 0 spike).

Lets the Phase 0 sessions run unattended: insert credits, press Start, plunge every
few seconds and never flip, so each ball drains and the game reaches Game Over.
Also runs the 0c lock exercise: with turn.lock present, presses the play keys so the
sidecar should swallow them (journal: lock locked=true, key_blocked ...).

Keys are sent as DirectInput scancodes via SendInput; VPX reads the keyboard through
DirectInput, so the player window must be in the foreground (the script brings it there).

Usage:
  autoplay.py game   [--credits 2] [--minutes 5] [--plunge-every 7] [--until-file F --until-text game_end --until-count N] [--no-start]
                     [--also 156,57]   extra scancodes tapped with every plunge (a lockbar / fire button that launches the ball)
                     [--after-start 4:start]   keys pressed after Start, each N seconds after the one before (a menu Start opens)
                     [--started-file F --started-text game_start --started-count N --start-retry 12 --start-tries 4]
                                       press Start again while the journal shows no game start (a table still booting);
                                       once it shows one, Start is never pressed again
                     [--quiet-seconds 15]      no key for 15 s after each ball end in --until-file, and none after the game end
  autoplay.py lock   [--lock-dir DIR]        one lock/unlock exercise (table must be running)
  autoplay.py press  <scancode> [--hold MS]  one key
  autoplay.py exit                           hold the exit key (Q) for 3 s
  autoplay.py focus                          just bring the player window to the front

Scancodes default to the owner's rig map: start=2 ("1"), plunger=28 (Enter), credit=6 ("5"),
lflip=42, rflip=54, exit=16 (Q). Override with --start/--plunge/--credit/--lflip/--rflip/--exit.
"""
import argparse, ctypes, ctypes.wintypes as wt, os, sys, time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

INPUT_KEYBOARD = 1
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _U)]

def key(sc, down):
    flags = KEYEVENTF_SCANCODE | (0 if down else KEYEVENTF_KEYUP)
    if sc > 0x7F:
        flags |= KEYEVENTF_EXTENDEDKEY
        sc &= 0x7F
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.u.ki = KEYBDINPUT(0, sc, flags, 0, None)
    n = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    if n != 1:
        raise OSError(f"SendInput failed: {ctypes.GetLastError()}")

def press(sc, hold_ms=80):
    key(sc, True); time.sleep(hold_ms / 1000.0); key(sc, False)

def find_player():
    hwnd = user32.FindWindowW(None, "Visual Pinball Player")
    if hwnd:
        return hwnd
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _):
        if user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(h, buf, n + 1)
                if "Visual Pinball" in buf.value and "Player" in buf.value:
                    found.append(h)
        return True
    user32.EnumWindows(cb, 0)
    return found[0] if found else 0

def focus(timeout=5.0):
    t0 = time.time()
    hwnd = 0
    while time.time() - t0 < timeout and not hwnd:
        hwnd = find_player()
        if not hwnd:
            time.sleep(0.25)
    if not hwnd:
        raise SystemExit("player window not found")
    if user32.GetForegroundWindow() != hwnd:
        # ALT tap unlocks SetForegroundWindow for a background process
        key(0x38, True); key(0x38, False)
        user32.ShowWindow(hwnd, 9)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    return hwnd

def file_count(path, text):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().count(text)
    except OSError:
        return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["game", "lock", "press", "exit", "focus"])
    ap.add_argument("scancode", nargs="?", type=int)
    ap.add_argument("--hold", type=int, default=80)
    ap.add_argument("--credits", type=int, default=2)
    ap.add_argument("--minutes", type=float, default=5)
    ap.add_argument("--plunge-every", type=float, default=7)
    ap.add_argument("--until-file"); ap.add_argument("--until-text", default="game_end")
    ap.add_argument("--until-count", type=int, default=1, help="stop once --until-text occurs this many times")
    ap.add_argument("--no-start", action="store_true", help="game already running: only plunge")
    ap.add_argument("--also", default="", help="comma-separated scancodes tapped with every plunge (lockbar / fire button)")
    ap.add_argument("--after-start", default="", help="keys pressed after Start, e.g. '4:start,1.5:plunge' (seconds to wait : start|plunge|credit|lflip|rflip|<scancode>)")
    ap.add_argument("--started-file"); ap.add_argument("--started-text", default='"event":"game_start"')
    ap.add_argument("--started-count", type=int, default=1, help="the game has started once --started-text occurs this many times in --started-file")
    ap.add_argument("--start-retry", type=float, default=12, help="seconds to wait for the game start before pressing Start again")
    ap.add_argument("--start-tries", type=int, default=4, help="Start presses in all")
    ap.add_argument("--quiet-text", default='"event":"ball_end"', help="a new occurrence of this in --until-file stops the plunging for --quiet-seconds")
    ap.add_argument("--quiet-seconds", type=float, default=0, help="seconds without a key after each ball end (0 = keep plunging)")
    ap.add_argument("--start", type=int, default=2); ap.add_argument("--plunge", type=int, default=28)
    ap.add_argument("--credit", type=int, default=6); ap.add_argument("--lflip", type=int, default=42)
    ap.add_argument("--rflip", type=int, default=54); ap.add_argument("--exit", type=int, default=16)
    ap.add_argument("--lock-dir", default=os.path.join(os.environ.get("LOCALAPPDATA", ""), "Castcade", "lock"))
    a = ap.parse_args()
    log = lambda *x: print(time.strftime("%H:%M:%S"), *x, flush=True)

    if a.mode == "focus":
        log("hwnd", focus()); return
    if a.mode == "press":
        focus(); press(a.scancode, a.hold); log("pressed", a.scancode); return
    if a.mode == "exit":
        focus(); log("holding exit key"); key(a.exit, True); time.sleep(3.0); key(a.exit, False); return

    if a.mode == "lock":
        lock = os.path.join(a.lock_dir, "turn.lock")
        focus()
        log("flip while UNLOCKED (should pass through)"); press(a.lflip, 150); press(a.rflip, 150); time.sleep(0.5)
        open(lock, "w").close(); log("lock ON")
        time.sleep(0.3)
        log("press lflip, rflip, plunger, start while LOCKED (expect key_blocked x4)")
        for sc in (a.lflip, a.rflip, a.plunge, a.start):
            press(sc, 150); time.sleep(0.4)
        log("hold rflip down while locked, unlock, release (key-up must be swallowed too)")
        key(a.rflip, True); time.sleep(0.5); os.remove(lock); log("lock OFF"); time.sleep(0.5); key(a.rflip, False)
        time.sleep(0.5)
        log("hold lflip down while unlocked, lock, release (key-up must pass through)")
        key(a.lflip, True); time.sleep(0.5); open(lock, "w").close(); log("lock ON"); time.sleep(0.5); key(a.lflip, False)
        time.sleep(0.5); os.remove(lock); log("lock OFF")
        log("flip while UNLOCKED again"); press(a.lflip, 150); press(a.rflip, 150)
        return

    # game
    also = [int(s) for s in a.also.split(",") if s.strip().isdigit()]
    def plunge():
        press(a.plunge, 600)
        for sc in also:
            time.sleep(0.2); press(sc, 150)
        log("plunge" + (f" + {also}" if also else ""))
    names = {"start": a.start, "plunge": a.plunge, "credit": a.credit, "lflip": a.lflip, "rflip": a.rflip}
    steps = []
    for part in [p.strip() for p in a.after_start.split(",") if p.strip()]:
        secs, _, name = part.partition(":")
        if name not in names and not name.isdigit():
            raise SystemExit(f"--after-start: unknown key '{name}' in '{part}'")
        steps.append((float(secs), name))
    def start_game():
        for _ in range(a.credits):
            press(a.credit); time.sleep(0.4)
        log(f"credits x{a.credits}")
        press(a.start, 120); log("start")
        for secs, name in steps:
            time.sleep(secs); focus()
            press(names[name] if name in names else int(name), 120); log(f"after start: {name}")
    started = lambda: (not a.started_file) or file_count(a.started_file, a.started_text) >= a.started_count
    focus()
    if not a.no_start:
        start_game()
        tries = 1
        # a Start the table ignored (still booting, an intro running): press it again until the journal has the game start
        while a.started_file and tries < a.start_tries:
            t = time.time()
            while time.time() - t < a.start_retry and not started():
                time.sleep(0.5)
            if started():
                break
            log(f"no {a.started_text} {a.start_retry:.0f}s after Start; pressing Start again ({tries + 1}/{a.start_tries})")
            focus(); start_game(); tries += 1
        time.sleep(2.5)
        plunge()
    # No key after the game end, and none for --quiet-seconds after each ball end: a table that is over takes the
    # plunger or the lockbar for Start (Game of Thrones: five games in one run, each begun during the match sequence
    # of the one before, 2026-11-12). The journal is read twice a second, so the game end stops the keys at once.
    t0 = time.time(); deadline = t0 + a.minutes * 60
    next_plunge = t0 + a.plunge_every
    quiet_until = 0.0
    seen = file_count(a.until_file, a.quiet_text) if a.until_file and a.quiet_seconds > 0 else 0
    while time.time() < deadline:
        time.sleep(0.5)
        if a.until_file and file_count(a.until_file, a.until_text) >= a.until_count:
            log(f"'{a.until_text}' x{a.until_count} seen in {os.path.basename(a.until_file)} after {time.time()-t0:.0f}s"); return
        if a.until_file and a.quiet_seconds > 0:
            n = file_count(a.until_file, a.quiet_text)
            if n > seen:
                seen = n; quiet_until = time.time() + a.quiet_seconds
                log(f"{a.quiet_text} x{n}; no keys for {a.quiet_seconds:.0f}s")
        now = time.time()
        if now >= next_plunge and now >= quiet_until:
            focus(); plunge(); next_plunge = time.time() + a.plunge_every
    log("time budget exhausted")

if __name__ == "__main__":
    main()
