#!/usr/bin/env python3
"""render-sidecar.py -- Phase 0 spike renderer for Castcade table sidecars.

Takes a table script extracted with `vpxtool extractvbs`, classifies it with the rules in
docs/design/table-import-and-patching.md section 4, applies the matching recipe from section 5
and writes a same-basename sidecar .vbs.  This is the hand-rolled ancestor of the Phase 3
`patcher` module: regex + anchors, no VBScript parser.

    python render-sidecar.py <extracted.vbs> <sidecar-out.vbs> [--table-id ID] [--recipe auto|A|B]
                              [--extra-keys KeyUpperLeft,KeyUpperRight] [--report out.json]
                              [--players-expr E] [--scores-expr E] [--player-expr E] [--ball-expr E]
                              [--extra-expr E] [--ballend-sub NAME] [--gameend-sub NAME]
                              [--gamestart-sub NAME] [--addscore-sub NAME]

Never touches the .vpx.  Delete the rendered .vbs to revert.  Bytes of the original script are
preserved (cp1252 + surrogateescape round-trip); everything inserted is ASCII.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime

LIB_VERSION = "0.1.0"
RECIPE_VERSION = "0.1.0"

# ----------------------------------------------------------------------------- helpers ----

def strip_comment(line: str) -> str:
    """Return the code part of a VBScript line (text before a ' that is outside a string)."""
    out = []
    in_str = False
    for ch in line:
        if ch == '"':
            in_str = not in_str
        elif ch == "'" and not in_str:
            break
        out.append(ch)
    return "".join(out)


def find_line(lines, pattern, start=0, end=None, flags=re.I):
    rx = re.compile(pattern, flags)
    end = len(lines) if end is None else end
    for i in range(start, end):
        if rx.search(strip_comment(lines[i])):
            return i
    return -1


def find_sub(lines, name):
    """(start, end) line indexes of `Sub <name>` ... `End Sub`, or (-1, -1)."""
    s = find_line(lines, r"^\s*(Public\s+|Private\s+)?(Sub|Function)\s+%s\s*(\(|$)" % re.escape(name))
    if s < 0:
        return -1, -1
    e = find_line(lines, r"^\s*End\s+(Sub|Function)\b", s + 1)
    return s, e


def has_ident(lines, ident):
    rx = re.compile(r"\b%s\b" % re.escape(ident), re.I)
    return any(rx.search(strip_comment(l)) for l in lines)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ----------------------------------------------------------------------------- analyzer ---

def classify(lines):
    """Section 4 rules, first match wins.  Returns (cls, facts)."""
    facts = {}
    kd = find_line(lines, r"^\s*(Public\s+|Private\s+)?Sub\s+(\w+)_KeyDown\s*\(")
    if kd < 0:
        return "X", {"reason": "no _KeyDown handler"}
    m = re.search(r"Sub\s+(\w+)_KeyDown", strip_comment(lines[kd]), re.I)
    facts["table_object"] = m.group(1)
    facts["keydown_line"] = kd + 1
    facts["keyup_line"] = find_line(lines, r"^\s*(Public\s+|Private\s+)?Sub\s+%s_KeyUp\s*\(" % re.escape(facts["table_object"])) + 1
    facts["exit_line"] = find_line(lines, r"^\s*(Public\s+|Private\s+)?Sub\s+%s_Exit\b" % re.escape(facts["table_object"])) + 1
    facts["option_explicit_line"] = find_line(lines, r"^\s*Option\s+Explicit\b") + 1
    facts["nvram_callback_already_set"] = find_line(lines, r"\bSet\s+NVRAMCallback\b") >= 0
    facts["use_vpm_nvram_declared"] = find_line(lines, r"^\s*(Dim|Const)\s+UseVPMNVRAM\b") >= 0
    facts["scorbit_anchors"] = {
        k: find_line(lines, r"\bScorbit\.%s\b" % k) + 1 for k in ("StartSession", "SendUpdate", "StopSession")
    }
    facts["score_server"] = find_line(lines, r'CreateObject\s*\(\s*"VPinball\.ScoreServer"') >= 0 or has_ident(lines, "SetScoresArray")

    loadvpm = find_line(lines, r"^\s*LoadVPM\b")
    vpm_ctrl = find_line(lines, r'CreateObject\s*\(\s*"VPinMAME\.Controller"\s*\)') >= 0
    if loadvpm >= 0 or vpm_ctrl:
        facts["loadvpm_line"] = loadvpm + 1
        rom = None
        rx = re.compile(r"\bcGameName\s*=\s*\"([^\"]+)\"", re.I)
        for l in lines:
            mm = rx.search(strip_comment(l))
            if mm:
                rom = mm.group(1)
                break
        facts["rom"] = rom
        return "A", facts

    subs = {n: find_sub(lines, n)[0] + 1 for n in ("AddScore", "ResetForNewGame", "EndOfGame", "EndOfBall")}
    facts["subs"] = subs
    facts["score_array"] = find_line(lines, r"^\s*Dim\s+Score\s*\(") >= 0
    if subs["AddScore"] and subs["ResetForNewGame"] and subs["EndOfGame"]:
        return "B", facts
    if all(facts["scorbit_anchors"].values()):
        return "C", facts
    if facts["score_server"]:
        return "D", facts
    if has_ident(lines, "Score") or has_ident(lines, "AddScore") or has_ident(lines, "Points"):
        return "E", facts
    return "X", dict(facts, reason="no scoring identifiers")


# ----------------------------------------------------------------------------- recipes ----

STUB = (
    "Sub Castcade_Init(a,b,c,d):End Sub:Sub Castcade_RegisterNVRAM():End Sub:"
    "Function Castcade_KeyDownBlocked(k):Castcade_KeyDownBlocked=False:End Function:"
    "Function Castcade_KeyUpBlocked(k):Castcade_KeyUpBlocked=False:End Function:"
    "Sub Castcade_GameStart(p):End Sub:Sub Castcade_Scores(s,p,b):End Sub:"
    "Sub Castcade_BallEnd(p,b,e):End Sub:Sub Castcade_GameEnd(s,p):End Sub:"
    "Sub Castcade_Event(n,j):End Sub:Sub Castcade_Exit():End Sub:Sub Castcade_AddPlayKeys(a):End Sub"
)


def block0(table_id, recipe, rom, extra_keys):
    b = [
        "' --- Castcade (recipe %s v%s, lib %s) --- do not edit; delete this .vbs to revert to the embedded script" % (recipe, RECIPE_VERSION, LIB_VERSION),
        "On Error Resume Next",
        'ExecuteGlobal GetTextFile("castcade.vbs")',
        "Dim Castcade_Probe : Castcade_Probe = Empty : Err.Clear : Castcade_Probe = Eval(\"Castcade_LibVersion\")",
        "If Err.Number <> 0 Or IsEmpty(Castcade_Probe) Then",
        "    ' library missing: install no-op stubs so the table still runs, and leave a breadcrumb",
        '    ExecuteGlobal "%s"' % STUB,
        '    CreateObject("Scripting.FileSystemObject").OpenTextFile(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%TEMP%") & "\\castcade-sidecar-ran-but-no-library.txt", 8, True).WriteLine Now & "  ' + table_id.replace('"', "") + '"',
        "End If",
        "On Error Goto 0",
        'Castcade_Init "%s", "%s", "%s", "%s"' % (table_id.replace('"', ""), recipe, RECIPE_VERSION, rom or ""),
    ]
    if extra_keys:
        b.append("Castcade_AddPlayKeys Array(%s)" % ", ".join('"%s"' % k for k in extra_keys))
    b.append("' --- end Castcade block 0 ---")
    return b


def wrappers(table_object, have_keyup, have_exit):
    w = [
        "",
        "' --- Castcade turn lock + exit hook (renamed originals: Castcade_Orig_KeyDown / _KeyUp / _Exit) ---",
        "Sub %s_KeyDown(ByVal KeyCode)" % table_object,
        "    If Castcade_KeyDownBlocked(KeyCode) Then Exit Sub",
        "    Castcade_Orig_KeyDown KeyCode",
        "End Sub",
    ]
    if have_keyup:
        w += [
            "Sub %s_KeyUp(ByVal KeyCode)" % table_object,
            "    If Castcade_KeyUpBlocked(KeyCode) Then Exit Sub",
            "    Castcade_Orig_KeyUp KeyCode",
            "End Sub",
        ]
    w += ["Sub %s_Exit()" % table_object, "    Castcade_Exit"]
    if have_exit:
        w.append("    Castcade_Orig_Exit")
    w += ["End Sub", "' --- end Castcade ---"]
    return w


def rename_handler(lines, table_object, suffix, idx):
    """Rename `Sub <T>_<suffix>(...)` at line idx to `Sub Castcade_Orig_<suffix>(...)`."""
    rx = re.compile(r"(\bSub\s+)%s_%s\b" % (re.escape(table_object), suffix), re.I)
    lines[idx] = rx.sub(r"\1Castcade_Orig_%s" % suffix, lines[idx], count=1)


def render(lines, cls, facts, args, report):
    out = list(lines)
    inserts = []  # (index, [lines]) applied bottom-up so indexes stay valid

    T = facts["table_object"]
    extra_keys = [k for k in (args.extra_keys or "").split(",") if k.strip()]
    recipe = cls
    rom = facts.get("rom")

    # block 0
    oe = facts["option_explicit_line"]
    inserts.append((oe if oe > 0 else 0, block0(args.table_id, recipe, rom, extra_keys)))

    # handlers
    rename_handler(out, T, "KeyDown", facts["keydown_line"] - 1)
    if facts["keyup_line"] > 0:
        rename_handler(out, T, "KeyUp", facts["keyup_line"] - 1)
    if facts["exit_line"] > 0:
        rename_handler(out, T, "Exit", facts["exit_line"] - 1)

    if cls == "A":
        lv = facts.get("loadvpm_line", 0)
        if lv <= 0:
            report["warnings"].append("no LoadVPM call line; NVRAM registration anchor missing (recipe A partial)")
        else:
            if facts["use_vpm_nvram_declared"]:
                report["warnings"].append("UseVPMNVRAM already declared by the table; forcing it True before LoadVPM without a Dim")
                inserts.append((lv - 1, ["UseVPMNVRAM = True   ' Castcade: enable Controller.ChangedNVRAM delivery (core.vbs line 37)"]))
            else:
                inserts.append((lv - 1, ["Dim UseVPMNVRAM : UseVPMNVRAM = True   ' Castcade: enable Controller.ChangedNVRAM delivery (core.vbs line 37)"]))
            inserts.append((lv, ["Castcade_RegisterNVRAM   ' Castcade: the one place NVRAMCallback is set (chains any existing callback)"]))
            if facts["nvram_callback_already_set"]:
                report["warnings"].append("table already sets NVRAMCallback; Castcade_RegisterNVRAM will chain it")
        if not rom:
            report["warnings"].append("cGameName not found; journal rom field empty")

    elif cls in ("B", "C"):
        def expr_ok(e):
            idents = re.findall(r"[A-Za-z_]\w*", e)
            missing = [i for i in idents if i.lower() not in ("array",) and not has_ident(lines, i)]
            return missing
        exprs = {
            "players": args.players_expr,
            "scores": args.scores_expr,
            "player": args.player_expr,
            "ball": args.ball_expr,
            "extra": args.extra_expr,
        }
        for k, e in exprs.items():
            miss = expr_ok(e)
            if miss:
                report["warnings"].append("%s expression '%s' references unknown identifiers %s; using 0" % (k, e, miss))
                exprs[k] = "0"
        report["expressions"] = exprs

        s, e = find_sub(out, args.gamestart_sub)
        if s >= 0:
            inserts.append((e, ["    Castcade_GameStart %s   ' Castcade" % exprs["players"]]))
            report["anchors"]["game_start"] = "%s: before End Sub (line %d)" % (args.gamestart_sub, e + 1)
        else:
            report["warnings"].append("Sub %s not found (game_start anchor)" % args.gamestart_sub)

        s, e = find_sub(out, args.addscore_sub)
        if s >= 0:
            inserts.append((e, ["    Castcade_Scores %s, %s, %s   ' Castcade" % (exprs["scores"], exprs["player"], exprs["ball"])]))
            report["anchors"]["current_scores"] = "%s: before End Sub (line %d)" % (args.addscore_sub, e + 1)
        else:
            report["warnings"].append("Sub %s not found (current_scores anchor)" % args.addscore_sub)

        s, e = find_sub(out, args.ballend_sub)
        if s >= 0:
            inserts.append((s + 1, ["    Castcade_BallEnd %s, %s, %s   ' Castcade" % (exprs["player"], exprs["ball"], exprs["extra"])]))
            report["anchors"]["ball_end"] = "%s: first line (line %d)" % (args.ballend_sub, s + 2)
        else:
            report["warnings"].append("Sub %s not found (ball_end anchor)" % args.ballend_sub)

        s, e = find_sub(out, args.gameend_sub)
        if s >= 0:
            inserts.append((s + 1, ["    Castcade_GameEnd %s, %s   ' Castcade" % (exprs["scores"], exprs["players"])]))
            report["anchors"]["game_end"] = "%s: first line (line %d)" % (args.gameend_sub, s + 2)
        else:
            report["warnings"].append("Sub %s not found (game_end anchor)" % args.gameend_sub)

    else:
        report["warnings"].append("class %s: only block 0 + turn lock rendered (no scoring anchors)" % cls)

    # apply inserts bottom-up
    for idx, blk in sorted(inserts, key=lambda x: x[0], reverse=True):
        out[idx:idx] = blk

    out += wrappers(T, facts["keyup_line"] > 0, facts["exit_line"] > 0)
    return out


# ----------------------------------------------------------------------------- main -------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script")
    ap.add_argument("out")
    ap.add_argument("--table-id", default=None, help="default: basename of the script without extension")
    ap.add_argument("--recipe", default="auto", choices=["auto", "A", "B", "C", "E"])
    ap.add_argument("--extra-keys", default="", help="comma list of extra key constant NAMES to lock (e.g. KeyUpperLeft,KeyUpperRight)")
    ap.add_argument("--report", default=None, help="write the classification/anchor report as JSON here")
    ap.add_argument("--players-expr", default="PlayersPlayingGame")
    ap.add_argument("--scores-expr", default="Array(Score(0),Score(1),Score(2),Score(3))")
    ap.add_argument("--player-expr", default="CurrentPlayer+1")
    ap.add_argument("--ball-expr", default="Balls")
    ap.add_argument("--extra-expr", default="ExtraBallsAwards(CurrentPlayer)")
    ap.add_argument("--gamestart-sub", default="ResetForNewGame")
    ap.add_argument("--addscore-sub", default="AddScore")
    ap.add_argument("--ballend-sub", default="EndOfBall")
    ap.add_argument("--gameend-sub", default="EndOfGame")
    args = ap.parse_args()

    raw = open(args.script, "rb").read()
    text = raw.decode("cp1252", errors="surrogateescape")
    nl = "\r\n" if text.count("\r\n") >= text.count("\n") // 2 else "\n"
    lines = text.split("\r\n") if nl == "\r\n" else text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    args.table_id = args.table_id or os.path.splitext(os.path.basename(args.script))[0]
    report = {
        "table_id": args.table_id,
        "script": os.path.abspath(args.script),
        "script_sha256": sha256_bytes(raw),
        "script_lines": len(lines),
        "rendered_at": datetime.now().isoformat(timespec="seconds"),
        "lib_version": LIB_VERSION,
        "recipe_version": RECIPE_VERSION,
        "anchors": {},
        "warnings": [],
    }

    if any("Castcade_Init" in strip_comment(l) for l in lines):
        report["error"] = "script already contains Castcade_Init (already patched); refusing"
        print(json.dumps(report, indent=2))
        sys.exit(2)

    cls, facts = classify(lines)
    report["class"] = cls
    report["facts"] = facts
    if args.recipe != "auto":
        report["recipe_override"] = args.recipe
        cls = args.recipe
    report["recipe"] = cls
    if cls == "X":
        report["error"] = "unsupported: %s" % facts.get("reason")
        print(json.dumps(report, indent=2))
        sys.exit(3)

    out = render(lines, cls, facts, args, report)
    data = (nl.join(out) + nl).encode("cp1252", errors="surrogateescape")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "wb") as fh:
        fh.write(data)
    report["sidecar"] = os.path.abspath(args.out)
    report["sidecar_sha256"] = sha256_bytes(data)
    report["sidecar_lines"] = len(out)
    report["status"] = "partial" if report["warnings"] else "rendered"

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    print(json.dumps({k: report[k] for k in ("table_id", "class", "recipe", "status", "anchors", "warnings", "sidecar")}, indent=2))
    if "rom" in facts:
        print("rom:", facts["rom"])


if __name__ == "__main__":
    main()
