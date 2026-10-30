' =====================================================================================
'  castcade.vbs  --  Castcade shared VBScript library        version 0.4.1
' -------------------------------------------------------------------------------------
'  Installed by Castcade as a NEW file in <VPX>\scripts\ (next to core.vbs; nothing existing
'  is modified).  A per-table sidecar loads it with
'      ExecuteGlobal GetTextFile("castcade.vbs")
'      Castcade_Init "<table-id>", "<recipe>", "<recipe-version>", "<rom or empty>"
'      Castcade_Guard "<original .vpx path>", <size>, "<yyyy-mm-dd hh:nn:ss local mtime>", "<this .vbs path>"
'      Castcade_WatchBytes Array(<nvram offsets the map's game_state reads>)
'  (Castcade_Guard is new in 0.2.0, Castcade_WatchBytes in 0.3.0; older sidecars do not call them and
'   keep working — without a watch list every changed byte is journaled, the 0.1.0 behaviour.)
'
'  0.3.0 journal volume: with a watch list, Castcade_NVRAM keeps only the watched offsets of each
'  ChangedNVRAM batch, coalesces them (latest value per offset, the first old value) and writes at
'  most one nvram_delta line per 50 ms, flushed at once; the full snapshot is taken once, at hook
'  time.  A WPC table went from ~100 lines/s (22 MB per 7 minutes, long frames at every snapshot)
'  to a few lines per score change.  An EMPTY watch list (ROM without a map) journals no deltas.
'
'  Working agreement (castcade/CLAUDE.md):
'   * No real work in VBScript.  This file appends lines to a journal and reads one lock flag.
'     Decoding, detection and networking live in the companion.
'   * Every host touch runs under On Error Resume Next.  A failure here must never stop a table.
'   * Controller.ChangedNVRAM is a destructive single-consumer read.  The ONLY place that sets
'     NVRAMCallback is Castcade_RegisterNVRAM, which chains any callback already installed.
'
'  Journal  : %LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl   (one JSON object per line)
'  Lock flag: %LOCALAPPDATA%\Castcade\lock\turn.lock              (file exists = NOT your turn)
'
'  Journal events (key "event"; every line also carries "t" = seconds since table load):
'    table_loaded   table, recipe, recipe_version, rom, lib, session, locked
'    nvram_hook     chained, use_nvram            (VPM tables: callback registered)
'    nvram_full     n, bytes[]                    (VPM: full Controller.NVRAM baseline)
'    nvram_delta    n, d[[offset,new,old],...]    (VPM: Controller.ChangedNVRAM batch)
'    game_start     players                       (originals)
'    current_scores scores[], player, ball        (originals; player and ball are 1-based)
'    ball_end       player, ball, extra_balls     (originals)
'    game_end       scores[], players             (originals)
'    lock           locked                        (lock state seen at a key press changed)
'    key_blocked    key                           (a play key was swallowed while locked)
'    warn           msg, err
'    stale_sidecar  detail, original             (0.2.0: the .vpx no longer matches the sidecar's stamp;
'                                                 the sidecar renamed itself .stale, see Castcade_Guard)
'    embedded_patch original                     (0.4.1: this patch runs from the table's own script, not a
'                                                 sidecar: the VPX editor saved it into the .vpx; nothing is stale)
'    table_exit     lines, nvram_callbacks, blocked_keys
'  nvram_full / nvram_delta use the same shape as ArcAid's T7 probe so its decoder also works.
' =====================================================================================

Dim Castcade_LibVersion : Castcade_LibVersion = "0.4.1"
Dim Castcade_fso, Castcade_shell, Castcade_Root, Castcade_JournalPath, Castcade_LockPath
Dim Castcade_Log, Castcade_LogOpen, Castcade_T0, Castcade_Lines, Castcade_Session
Dim Castcade_TableId, Castcade_Recipe, Castcade_RecipeVer, Castcade_Rom
Dim Castcade_PrevNVRAM, Castcade_NVRAMRegistered, Castcade_NVn
Dim Castcade_Watch, Castcade_WatchOn, Castcade_Pending, Castcade_LastDeltaT, Castcade_Filtered
Dim Castcade_PlayKeys, Castcade_PlayKeysReady, Castcade_ExtraKeyNames, Castcade_Swallowed, Castcade_LastLocked
Dim Castcade_LastScores, Castcade_Blocked
Dim Castcade_EngineLast, Castcade_Dec

Castcade_EngineLast = ""
Castcade_Dec = "."
Castcade_LogOpen = False
Castcade_NVRAMRegistered = False
Castcade_PlayKeysReady = False
Castcade_ExtraKeyNames = Array()
Castcade_LastScores = ""
Castcade_Blocked = 0
Castcade_NVn = 0
Castcade_Lines = 0
Castcade_WatchOn = False
Castcade_LastDeltaT = -1
Castcade_Filtered = 0

' ---------------------------------------------------------------- init / exit ----------

Sub Castcade_Init(tableId, recipe, recipeVer, rom)
    On Error Resume Next
    Castcade_TableId = tableId : Castcade_Recipe = recipe : Castcade_RecipeVer = recipeVer : Castcade_Rom = rom
    Castcade_T0 = Timer
    Castcade_Dec = Mid(FormatNumber(0.5, 1, -1, 0, 0), 2, 1)
    If Castcade_Dec = "" Then Castcade_Dec = "."
    Castcade_LastLocked = Empty
    Set Castcade_Swallowed = CreateObject("Scripting.Dictionary")
    Set Castcade_fso = CreateObject("Scripting.FileSystemObject")
    Set Castcade_shell = CreateObject("WScript.Shell")

    Castcade_Root = ""
    Castcade_Root = Castcade_shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
    If Castcade_Root = "" Or Left(Castcade_Root, 1) = "%" Then Castcade_Root = Castcade_shell.ExpandEnvironmentStrings("%TEMP%")
    If Castcade_Root = "" Or Left(Castcade_Root, 1) = "%" Then Castcade_Root = "C:\Castcade"
    Castcade_Root = Castcade_Root & "\Castcade"
    Castcade_EnsureDir Castcade_Root
    Castcade_EnsureDir Castcade_Root & "\journal"
    Castcade_EnsureDir Castcade_Root & "\lock"
    Castcade_JournalPath = Castcade_Root & "\journal\" & Castcade_SafeName(tableId) & ".jsonl"
    Castcade_LockPath = Castcade_Root & "\lock\turn.lock"
    Castcade_Session = Castcade_Stamp()

    Castcade_OpenLog
    Castcade_Emit "table_loaded", _
        """table"":" & Castcade_Q(tableId) & ",""recipe"":" & Castcade_Q(recipe) & _
        ",""recipe_version"":" & Castcade_Q(recipeVer) & ",""rom"":" & Castcade_Q(rom) & _
        ",""lib"":" & Castcade_Q(Castcade_LibVersion) & ",""session"":" & Castcade_Q(Castcade_Session) & _
        ",""locked"":" & Castcade_Bool(Castcade_Locked())
    Castcade_EngineSample "init"
End Sub

Sub Castcade_Exit()
    On Error Resume Next
    If Castcade_WatchOn Then
        If Castcade_Pending.Count > 0 Then Castcade_FlushPending
    End If
    Castcade_Emit "table_exit", """lines"":" & Castcade_Lines & ",""nvram_callbacks"":" & Castcade_NVn & ",""blocked_keys"":" & Castcade_Blocked & ",""filtered_bytes"":" & Castcade_Filtered
    If Castcade_LogOpen Then Castcade_Log.Close
    Castcade_LogOpen = False
End Sub

' ---------------------------------------------------------------- stale-sidecar guard --

' Called by a 0.2.0+ sidecar right after Castcade_Init with the original .vpx's path, byte size and
' local mtime ("yyyy-mm-dd hh:nn:ss") as they were when the sidecar was rendered, plus the sidecar's
' own path.  A sidecar REPLACES the embedded script, so a table update would run the old script on
' new geometry (design doc section 6).  On a mismatch the sidecar journals stale_sidecar, renames
' itself <Table>.vbs.stale and tells the player to relaunch and re-import; the table keeps running on
' the old script for this one session.  VBScript cannot hash, so the size is the strong signal; the
' mtime tolerance is +/-3601 s because DST transitions and FILETIME conversions shift it by an hour.
' A missing original (moved table) is not a mismatch: nothing happens.
' 0.4.1: a missing SIDECAR means this script is the table's own: the VPX editor loads a sidecar as the
' table's script and saves it back into the .vpx (Krobs, 2026-10-29). Script and table were saved
' together, so nothing is stale; the stamp would never match again and the dialog would show at every
' launch with nothing to rename. Journal embedded_patch instead and carry on; the companion renders a
' fresh sidecar over it at the next import.
Sub Castcade_Guard(originalPath, originalSize, originalMtime, sidecarPath)
    On Error Resume Next
    Dim f, size, modified, want, diff, detail
    If Not IsObject(Castcade_fso) Then Exit Sub
    If Not Castcade_fso.FileExists(originalPath) Then Exit Sub
    If Not Castcade_fso.FileExists(sidecarPath) Then
        Castcade_Emit "embedded_patch", """original"":" & Castcade_Q(originalPath)
        Exit Sub
    End If
    Set f = Castcade_fso.GetFile(originalPath)
    size = f.Size
    modified = f.DateLastModified
    detail = ""
    If CDbl(size) <> CDbl(originalSize) Then detail = "size " & size & " vs " & originalSize
    want = Castcade_ParseStamp(originalMtime)
    If IsDate(want) And IsDate(modified) Then
        diff = DateDiff("s", want, modified)
        If Abs(diff) > 3601 Then
            If detail <> "" Then detail = detail & "; "
            detail = detail & "mtime " & Castcade_StampOf(modified) & " vs " & originalMtime & " (" & diff & " s)"
        End If
    End If
    If detail = "" Then Exit Sub
    Castcade_Emit "stale_sidecar", """detail"":" & Castcade_Q(detail) & ",""original"":" & Castcade_Q(originalPath)
    If Castcade_fso.FileExists(sidecarPath & ".stale") Then Castcade_fso.DeleteFile sidecarPath & ".stale", True
    If Castcade_fso.FileExists(sidecarPath) Then Castcade_fso.MoveFile sidecarPath, sidecarPath & ".stale"
    MsgBox "This Castcade patch was made for an older version of this table. It has been disabled - close the table, relaunch it, then re-import it from Castcade.", vbExclamation, "Castcade"
End Sub

' "yyyy-mm-dd hh:nn:ss" -> Date, locale-independent (CDate would parse by the user's locale).  Empty on a bad stamp.
Function Castcade_ParseStamp(s)
    On Error Resume Next
    Castcade_ParseStamp = Empty
    If Len(s) < 19 Then Exit Function
    Castcade_ParseStamp = DateSerial(CInt(Mid(s, 1, 4)), CInt(Mid(s, 6, 2)), CInt(Mid(s, 9, 2))) + _
                          TimeSerial(CInt(Mid(s, 12, 2)), CInt(Mid(s, 15, 2)), CInt(Mid(s, 18, 2)))
End Function

' ---------------------------------------------------------------- turn lock ------------

Function Castcade_Locked()
    On Error Resume Next
    Castcade_Locked = False
    If IsObject(Castcade_fso) Then Castcade_Locked = Castcade_fso.FileExists(Castcade_LockPath)
End Function

' Call from the sidecar's <Table>_KeyDown wrapper.  True = swallow this key-down.
Function Castcade_KeyDownBlocked(keycode)
    On Error Resume Next
    Dim locked
    Castcade_KeyDownBlocked = False
    Castcade_EngineSample "key"
    locked = Castcade_Locked()
    If IsEmpty(Castcade_LastLocked) Then
        Castcade_LastLocked = locked
        Castcade_Emit "lock", """locked"":" & Castcade_Bool(locked)
    ElseIf locked <> Castcade_LastLocked Then
        Castcade_LastLocked = locked
        Castcade_Emit "lock", """locked"":" & Castcade_Bool(locked)
    End If
    If Not locked Then Exit Function
    If Castcade_IsPlayKey(keycode) Then
        Castcade_Swallowed(CStr(keycode)) = True
        Castcade_Blocked = Castcade_Blocked + 1
        Castcade_Emit "key_blocked", """key"":" & keycode
        Castcade_KeyDownBlocked = True
    End If
End Function

' Call from the sidecar's <Table>_KeyUp wrapper.  A key-up is swallowed only when its key-down
' was swallowed, so a flipper that went down always comes back up.
Function Castcade_KeyUpBlocked(keycode)
    On Error Resume Next
    Castcade_KeyUpBlocked = False
    If Castcade_Swallowed.Exists(CStr(keycode)) Then
        Castcade_Swallowed.Remove CStr(keycode)
        Castcade_KeyUpBlocked = True
    End If
End Function

' Extra table-specific key constant NAMES (e.g. staged-flipper keys).  Call before the first key press.
Sub Castcade_AddPlayKeys(names)
    On Error Resume Next
    Castcade_ExtraKeyNames = names
    Castcade_PlayKeysReady = False
End Sub

Function Castcade_IsPlayKey(keycode)
    On Error Resume Next
    If Not Castcade_PlayKeysReady Then Castcade_BuildPlayKeys
    Castcade_IsPlayKey = Castcade_PlayKeys.Exists(CStr(keycode))
End Function

Sub Castcade_BuildPlayKeys()
    On Error Resume Next
    Dim names, i
    Set Castcade_PlayKeys = CreateObject("Scripting.Dictionary")
    ' VPX host constants: flippers, plunger/launch, start, nudges, lockbar, magna-saves.
    ' Never ExitGame or the coin/service keys: a locked player must still be able to leave.
    names = Array("LeftFlipperKey", "RightFlipperKey", "PlungerKey", "StartGameKey", _
                  "LeftTiltKey", "RightTiltKey", "CenterTiltKey", "MechanicalTilt", _
                  "LockBarKey", "LeftMagnaSave", "RightMagnaSave")
    For i = 0 To UBound(names)
        Castcade_AddKeyByName names(i)
    Next
    For i = 0 To UBound(Castcade_ExtraKeyNames)
        Castcade_AddKeyByName Castcade_ExtraKeyNames(i)
    Next
    Castcade_PlayKeysReady = True
End Sub

Sub Castcade_AddKeyByName(name)
    On Error Resume Next
    Dim v
    Err.Clear
    If IsNumeric(name) Then
        v = CLng(name)
    Else
        v = Eval(name)
    End If
    If Err.Number = 0 Then
        If Not IsEmpty(v) Then
            If IsNumeric(v) Then Castcade_PlayKeys(CStr(CLng(v))) = name
        End If
    End If
    Err.Clear
End Sub

' ---------------------------------------------------------------- VPM / NVRAM ----------

' The one place NVRAMCallback is ever assigned.  Idempotent; chains an existing callback.
Sub Castcade_RegisterNVRAM()
    On Error Resume Next
    Dim chained, useNv
    If Castcade_NVRAMRegistered Then Exit Sub
    Castcade_PrevNVRAM = Empty
    chained = False
    Err.Clear
    If IsObject(NVRAMCallback) Then
        Set Castcade_PrevNVRAM = NVRAMCallback
        chained = True
    End If
    Err.Clear
    Set NVRAMCallback = GetRef("Castcade_NVRAM")
    If Err.Number <> 0 Then
        Castcade_Emit "warn", """msg"":""NVRAMCallback registration failed (core.vbs not loaded yet?)"",""err"":" & Castcade_Q(Err.Description)
        Err.Clear
        Exit Sub
    End If
    Castcade_NVRAMRegistered = True
    useNv = Empty
    useNv = Eval("UseNVRAM")
    Err.Clear
    Castcade_Emit "nvram_hook", """chained"":" & Castcade_Bool(chained) & ",""use_nvram"":" & Castcade_Q(CStr(useNv))
End Sub

' Receives Controller.ChangedNVRAM batches from core.vbs PinMAMETimer_Timer: chg(i,0)=offset, (i,1)=new, (i,2)=old
' The watch list (0.3.0): the NVRAM offsets worth journaling, from the ROM's map.  Call from block 0,
' before LoadVPM.  An empty array means "journal no deltas" (a ROM the companion cannot decode).
Sub Castcade_WatchBytes(offsets)
    On Error Resume Next
    Dim i
    Set Castcade_Watch = CreateObject("Scripting.Dictionary")
    Set Castcade_Pending = CreateObject("Scripting.Dictionary")
    If IsArray(offsets) Then
        For i = 0 To UBound(offsets)
            Castcade_Watch(CStr(CLng(offsets(i)))) = True
        Next
    End If
    Castcade_WatchOn = True
End Sub

' Receives Controller.ChangedNVRAM batches from core.vbs PinMAMETimer_Timer: chg(i,0)=offset, (i,1)=new, (i,2)=old.
' With a watch list: keep the watched offsets, coalesce them, write at most every 50 ms (flushed at once).
' Without one (0.1.0 / 0.2.0 sidecars): every byte, buffered, plus a full snapshot every 5000 batches.
Sub Castcade_NVRAM(chg)
    On Error Resume Next
    Dim i, n, parts, t, k, key
    Castcade_NVn = Castcade_NVn + 1
    If Castcade_NVn <= 300000 Then                      ' runaway guard
        t = Castcade_T()
        If Castcade_NVn = 1 Then Castcade_NVRAMFull t
        n = UBound(chg, 1)
        If Castcade_WatchOn Then
            For i = 0 To n
                key = CStr(chg(i, 0))
                If Castcade_Watch.Exists(key) Then
                    If Castcade_Pending.Exists(key) Then
                        Castcade_Pending(key) = Array(chg(i, 1), Castcade_Pending(key)(1))   ' latest new, first old
                    Else
                        Castcade_Pending(key) = Array(chg(i, 1), chg(i, 2))
                    End If
                Else
                    Castcade_Filtered = Castcade_Filtered + 1
                End If
            Next
            If Castcade_Pending.Count > 0 And (Castcade_LastDeltaT < 0 Or t - Castcade_LastDeltaT >= 0.05) Then
                ReDim parts(Castcade_Pending.Count - 1)
                i = 0
                For Each k In Castcade_Pending.Keys
                    parts(i) = "[" & k & "," & Castcade_Pending(k)(0) & "," & Castcade_Pending(k)(1) & "]"
                    i = i + 1
                Next
                Castcade_Write "{""event"":""nvram_delta"",""t"":" & t & ",""n"":" & Castcade_Pending.Count & ",""d"":[" & Join(parts, ",") & "]}", True
                Castcade_Pending.RemoveAll
                Castcade_LastDeltaT = t
            End If
        Else
            ReDim parts(n)
            For i = 0 To n
                parts(i) = "[" & chg(i, 0) & "," & chg(i, 1) & "," & chg(i, 2) & "]"
            Next
            Castcade_Write "{""event"":""nvram_delta"",""t"":" & t & ",""n"":" & (n + 1) & ",""d"":[" & Join(parts, ",") & "]}", False
            If (Castcade_NVn Mod 5000) = 0 Then Castcade_NVRAMFull t
        End If
    End If
    If IsObject(Castcade_PrevNVRAM) Then Castcade_PrevNVRAM chg
End Sub

' Write whatever is coalesced right now (table exit: the last change must not stay in the buffer).
Sub Castcade_FlushPending()
    On Error Resume Next
    Dim parts, i, k
    If Castcade_Pending.Count = 0 Then Exit Sub
    ReDim parts(Castcade_Pending.Count - 1)
    i = 0
    For Each k In Castcade_Pending.Keys
        parts(i) = "[" & k & "," & Castcade_Pending(k)(0) & "," & Castcade_Pending(k)(1) & "]"
        i = i + 1
    Next
    Castcade_Write "{""event"":""nvram_delta"",""t"":" & Castcade_T() & ",""n"":" & Castcade_Pending.Count & ",""d"":[" & Join(parts, ",") & "]}", True
    Castcade_Pending.RemoveAll
    Castcade_LastDeltaT = Castcade_T()
End Sub

Sub Castcade_NVRAMFull(t)
    On Error Resume Next
    Dim arr, i, parts
    arr = Controller.NVRAM
    If Not IsArray(arr) Then Exit Sub
    ReDim parts(UBound(arr))
    For i = 0 To UBound(arr)
        parts(i) = CStr(arr(i))
    Next
    Castcade_Write "{""event"":""nvram_full"",""t"":" & t & ",""n"":" & (UBound(arr) + 1) & ",""bytes"":[" & Join(parts, ",") & "]}", True
End Sub

' ---------------------------------------------------------------- originals ------------

Sub Castcade_GameStart(players)
    On Error Resume Next
    Castcade_LastScores = ""
    Castcade_Emit "game_start", """players"":" & Castcade_Num(players)
End Sub

' scores = Array(Score(0), Score(1), ...)   player, ball = 1-based
Sub Castcade_Scores(scores, player, ball)
    On Error Resume Next
    Dim js, sig
    js = Castcade_NumArray(scores)
    sig = js & "|" & player & "|" & ball
    If sig = Castcade_LastScores Then Exit Sub
    Castcade_LastScores = sig
    Castcade_Write "{""event"":""current_scores"",""t"":" & Castcade_T() & ",""scores"":" & js & ",""player"":" & Castcade_Num(player) & ",""ball"":" & Castcade_Num(ball) & "}", False
End Sub

Sub Castcade_BallEnd(player, ball, extraBalls)
    On Error Resume Next
    Castcade_Emit "ball_end", """player"":" & Castcade_Num(player) & ",""ball"":" & Castcade_Num(ball) & ",""extra_balls"":" & Castcade_Num(extraBalls)
End Sub

Sub Castcade_GameEnd(scores, players)
    On Error Resume Next
    Castcade_Emit "game_end", """scores"":" & Castcade_NumArray(scores) & ",""players"":" & Castcade_Num(players)
End Sub

' Free-form event for recipe-specific anchors.  extraJson is the inside of the object, no braces.
Sub Castcade_Event(name, extraJson)
    On Error Resume Next
    Castcade_Emit name, extraJson
End Sub

' ---------------------------------------------------------------- engine attestation (0.4.0) --
' What VPX has IN FORCE right now, read through the script API (`ActiveTable` and the global
' `NudgeGetCalibration`): the values the tweak menu and a community build's own pages change in
' memory without touching any file. Sampled once at hook time and at every key-down, written as an
' `engine` line only when something changed, so an unsaved in-game edit shows up at the next key
' press and the companion can tie it to the ball it was made on. A dozen property reads per key
' press; nothing when nothing changed. Any read that fails leaves its field null.
Sub Castcade_EngineSample(reason)
    On Error Resume Next
    Dim t, v, json, xmax, ymax, xgain, ygain, dead, tilt
    Err.Clear
    Set t = ActiveTable
    If Err.Number <> 0 Then Err.Clear : Exit Sub
    If t Is Nothing Then Exit Sub
    v = Empty : v = t.GlobalDifficulty : json = """difficulty"":" & Castcade_FloatOf(v)
    v = Empty : v = t.SlopeMin : json = json & ",""slope_min"":" & Castcade_FloatOf(v)
    v = Empty : v = t.SlopeMax : json = json & ",""slope_max"":" & Castcade_FloatOf(v)
    v = Empty : v = t.OverridePhysics : json = json & ",""physics_set"":" & Castcade_IntOf(v)
    v = Empty : v = t.Gravity : json = json & ",""gravity"":" & Castcade_FloatOf(v)
    v = Empty : v = t.Friction : json = json & ",""friction"":" & Castcade_FloatOf(v)
    v = Empty : v = t.Elasticity : json = json & ",""elasticity"":" & Castcade_FloatOf(v)
    v = Empty : v = t.ElasticityFalloff : json = json & ",""elasticity_falloff"":" & Castcade_FloatOf(v)
    v = Empty : v = t.Scatter : json = json & ",""scatter"":" & Castcade_FloatOf(v)
    v = Empty : v = t.NudgeTime : json = json & ",""nudge_time"":" & Castcade_FloatOf(v)
    Err.Clear
    NudgeGetCalibration xmax, ymax, xgain, ygain, dead, tilt
    If Err.Number = 0 Then
        json = json & ",""nudge"":{""xmax"":" & Castcade_IntOf(xmax) & ",""ymax"":" & Castcade_IntOf(ymax) & _
            ",""xgain"":" & Castcade_IntOf(xgain) & ",""ygain"":" & Castcade_IntOf(ygain) & _
            ",""dead_zone"":" & Castcade_IntOf(dead) & ",""tilt"":" & Castcade_IntOf(tilt) & "}"
    Else
        Err.Clear
        json = json & ",""nudge"":null"
    End If
    If reason <> "init" And json = Castcade_EngineLast Then Exit Sub
    Castcade_EngineLast = json
    Castcade_Emit "engine", """reason"":" & Castcade_Q(reason) & "," & json
End Sub

' A float as JSON with four decimals and a "." whatever the locale (FormatNumber uses the user's
' decimal symbol); Empty or a non-number is null.
Function Castcade_FloatOf(v)
    On Error Resume Next
    Dim s
    Castcade_FloatOf = "null"
    If IsEmpty(v) Or IsNull(v) Then Exit Function
    If Not IsNumeric(v) Then Exit Function
    s = FormatNumber(v, 4, -1, 0, 0)
    If Castcade_Dec <> "." Then s = Replace(s, Castcade_Dec, ".")
    Castcade_FloatOf = s
End Function

Function Castcade_IntOf(v)
    On Error Resume Next
    Castcade_IntOf = "null"
    If IsEmpty(v) Or IsNull(v) Then Exit Function
    If Not IsNumeric(v) Then Exit Function
    Castcade_IntOf = Castcade_Num(v)
End Function

' ---------------------------------------------------------------- journal plumbing -----

Sub Castcade_Emit(ev, extraJson)
    On Error Resume Next
    Dim line
    line = "{""event"":" & Castcade_Q(ev) & ",""t"":" & Castcade_T()
    If Len(extraJson) > 0 Then line = line & "," & extraJson
    line = line & "}"
    Castcade_Write line, True
End Sub

' flush=True closes and reopens the file so the companion sees the line now.  nvram_delta and
' current_scores pass False and are flushed every 50 lines (this runs at frame rate inside
' PinMAMETimer; a close/reopen per frame would stutter the table).
Sub Castcade_Write(line, flush)
    On Error Resume Next
    If Not Castcade_LogOpen Then Castcade_OpenLog
    If Not Castcade_LogOpen Then Exit Sub
    Castcade_Log.WriteLine line
    Castcade_Lines = Castcade_Lines + 1
    If flush Or (Castcade_Lines Mod 50) = 0 Then
        Castcade_Log.Close
        Castcade_LogOpen = False
        Castcade_OpenLog
    End If
End Sub

Sub Castcade_OpenLog()
    On Error Resume Next
    Castcade_LogOpen = False
    If Not IsObject(Castcade_fso) Then Exit Sub
    Err.Clear
    Set Castcade_Log = Castcade_fso.OpenTextFile(Castcade_JournalPath, 8, True)
    If Err.Number = 0 Then Castcade_LogOpen = True
    Err.Clear
End Sub

Sub Castcade_EnsureDir(p)
    On Error Resume Next
    If Not Castcade_fso.FolderExists(p) Then Castcade_fso.CreateFolder p
End Sub

' ---------------------------------------------------------------- helpers --------------

Function Castcade_T()
    On Error Resume Next
    Dim d
    d = Timer - Castcade_T0
    If d < 0 Then d = d + 86400              ' Timer wraps at midnight
    Castcade_T = Replace(CStr(Round(d, 3)), ",", ".")
End Function

Function Castcade_Stamp()
    On Error Resume Next
    Castcade_Stamp = Castcade_StampOf(Now)
End Function

Function Castcade_StampOf(n)
    On Error Resume Next
    Castcade_StampOf = Year(n) & "-" & Right("0" & Month(n), 2) & "-" & Right("0" & Day(n), 2) & "T" & _
                       Right("0" & Hour(n), 2) & ":" & Right("0" & Minute(n), 2) & ":" & Right("0" & Second(n), 2)
End Function

Function Castcade_Q(s)
    On Error Resume Next
    Dim r
    r = CStr(s)
    r = Replace(r, "\", "\\")
    r = Replace(r, """", "\""")
    r = Replace(r, vbCr, " ")
    r = Replace(r, vbLf, " ")
    r = Replace(r, vbTab, " ")
    Castcade_Q = """" & r & """"
End Function

Function Castcade_Bool(b)
    If b Then Castcade_Bool = "true" Else Castcade_Bool = "false"
End Function

' Integers of any size as plain digits (CStr of a large Double would use exponent notation).
Function Castcade_Num(v)
    On Error Resume Next
    Castcade_Num = "0"
    If IsNumeric(v) Then Castcade_Num = Replace(FormatNumber(v, 0, -1, 0, 0), ",", "")
    If Castcade_Num = "" Then Castcade_Num = "0"
End Function

Function Castcade_NumArray(arr)
    On Error Resume Next
    Dim i, parts
    Castcade_NumArray = "[]"
    If Not IsArray(arr) Then Exit Function
    ReDim parts(UBound(arr))
    For i = 0 To UBound(arr)
        parts(i) = Castcade_Num(arr(i))
    Next
    Castcade_NumArray = "[" & Join(parts, ",") & "]"
End Function

Function Castcade_SafeName(s)
    On Error Resume Next
    Dim i, c, r
    r = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        If InStr("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", c) > 0 Then
            r = r & c
        ElseIf c = " " Then
            r = r & "_"
        End If
    Next
    If r = "" Then r = "table"
    Castcade_SafeName = r
End Function
