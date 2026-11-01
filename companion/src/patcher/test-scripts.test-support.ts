/**
 * Synthetic table scripts for the patcher tests. Shapes only (the anchors the classifier and the
 * recipes look for); no text from a real table is reproduced here.
 */

export const VPM_SCRIPT = [
  'Option Explicit',
  'Randomize',
  '',
  'Const cGameName = "mb_106b"',
  'Const UseSolenoids = 1',
  "' LoadVPM is called below, not here",
  '',
  'LoadVPM "01560000", "WPC.VBS", 3.26',
  '',
  'Dim bsTrough',
  '',
  'Sub Table1_Init',
  '    With Controller',
  '        .GameName = cGameName',
  '    End With',
  '    On Error Resume Next',
  '    Controller.Run GetPlayerHWnd',
  '    On Error Goto 0',
  'End Sub',
  '',
  'Sub Table1_KeyDown(ByVal keycode)',
  '    If keycode = LeftFlipperKey Then Controller.Switch(swLLFlip) = True',
  '    If vpmKeyDown(keycode) Then Exit Sub',
  'End Sub',
  '',
  'Sub Table1_KeyUp(ByVal keycode)',
  '    If vpmKeyUp(keycode) Then Exit Sub',
  'End Sub',
  '',
  'Sub Table1_Exit()',
  '    Controller.Stop',
  'End Sub',
];

/** A VPM table that declares UseVPMNVRAM itself and already sets NVRAMCallback. */
export const VPM_DECLARED_SCRIPT = [
  'Dim UseVPMNVRAM : UseVPMNVRAM = False',
  'Const cGameName = "afm_113b"',
  'LoadVPM "01560000", "WPC.VBS", 3.26',
  'Set NVRAMCallback = GetRef("MyNvram")',
  'Sub MyNvram(chg)',
  'End Sub',
  'Sub MyTable_KeyDown(ByVal keycode)',
  'End Sub',
];

/** A VPM table that creates the controller itself, no LoadVPM, no cGameName, no KeyUp/Exit. */
export const VPM_NO_LOADVPM_SCRIPT = [
  'Dim Controller',
  'Set Controller = CreateObject("VPinMAME.Controller")',
  'Sub Table1_KeyDown(ByVal keycode)',
  'End Sub',
];

/** JPSalas-style original: Score() array, ResetForNewGame / AddScore / EndOfGame. */
export const ORIGINAL_B_SCRIPT = [
  'Option Explicit',
  'Dim Score(4), CurrentPlayer, PlayersPlayingGame, BallsRemaining(4)',
  '',
  'Sub Table1_KeyDown(ByVal keycode)',
  '    If keycode = StartGameKey Then ResetForNewGame',
  'End Sub',
  '',
  'Sub Table1_KeyUp(ByVal keycode)',
  'End Sub',
  '',
  'Sub ResetForNewGame()',
  '    Score(CurrentPlayer) = 0',
  'End Sub',
  '',
  'Sub AddScore(points)',
  '    Score(CurrentPlayer) = Score(CurrentPlayer) + points',
  'End Sub',
  '',
  'Sub EndOfGame()',
  'End Sub',
];

/** An original with only the Scorbit call sites. */
export const ORIGINAL_C_SCRIPT = [
  'Sub Table1_KeyDown(ByVal keycode)',
  'End Sub',
  'Sub StartGame()',
  '    Scorbit.StartSession',
  'End Sub',
  'Sub Tick()',
  '    Scorbit.SendUpdate',
  'End Sub',
  'Sub GameOver()',
  '    Scorbit.StopSession',
  'End Sub',
];

/**
 * A fuller JPSalas-pattern original (class B, recipe B): 1-based players, the `Balls` ball-number function, a tilt
 * `Exit Sub` in `AddScore`, a re-entry guard in `EndOfGame`, `EndOfBall` handing over to `EndOfBall2` where the
 * ball counter goes down. The shape the owner's originals share; none of their text.
 */
export const JPSALAS_B_SCRIPT = [
  'Option Explicit',
  'Const BallsPerGame = 3',
  'Const MaxPlayers = 4',
  'Dim Score(4), BallsRemaining(4), ExtraBallsAwards(4)',
  'Dim CurrentPlayer, PlayersPlayingGame, Tilted, bGameInPlay',
  '',
  'Sub Table1_KeyDown(ByVal keycode)',
  '    If keycode = StartGameKey And Not bGameInPlay Then ResetForNewGame',
  'End Sub',
  '',
  'Sub Table1_KeyUp(ByVal keycode)',
  'End Sub',
  '',
  'Sub Table1_Exit',
  '    bGameInPlay = False',
  'End Sub',
  '',
  'Sub ResetForNewGame()',
  '    Dim i',
  '    bGameInPlay = True',
  '    CurrentPlayer = 1',
  '    PlayersPlayingGame = 1',
  '    For i = 1 To MaxPlayers',
  '        Score(i) = 0',
  '        BallsRemaining(i) = BallsPerGame',
  '        ExtraBallsAwards(i) = 0',
  '    Next',
  'End Sub',
  '',
  'Sub AddScore(points)',
  "    If Tilted Then Exit Sub ' no points while tilted",
  '    Score(CurrentPlayer) = Score(CurrentPlayer) + points',
  'End Sub',
  '',
  'Sub EndOfBall()',
  '    AddScore 1000',
  '    EndOfBall2',
  'End Sub',
  '',
  'Sub EndOfBall2()',
  '    BallsRemaining(CurrentPlayer) = BallsRemaining(CurrentPlayer) - 1',
  '    If BallsRemaining(CurrentPlayer) <= 0 Then EndOfGame',
  'End Sub',
  '',
  'Sub EndOfGame()',
  '    If bGameInPlay = False Then Exit Sub',
  '    bGameInPlay = False',
  'End Sub',
  '',
  'Function Balls',
  '    Balls = BallsPerGame - BallsRemaining(CurrentPlayer) + 1',
  'End Function',
];

/**
 * A Scorbit-anchored original (class C, recipe C): its own variable names (0-based player), `StartSession` behind a
 * pairing guard in the game-start sub, `StopSession` in a Scorbit-named helper the game-end sub calls behind a
 * session guard, `SendUpdate` inside the Scorbit class's timer, an `Exit Sub` in `AddScore`, an `EndBall` sub.
 */
export const SCORBIT_C_SCRIPT = [
  'Option Explicit',
  'Dim aScore(4), nPlayer, nBall, nPlayers, ScorbitActive, bShowPup',
  'Dim Scorbit : Set Scorbit = New ScorbitIF',
  '',
  'Sub Table1_KeyDown(ByVal keycode)',
  '    If keycode = StartGameKey Then StartGame',
  'End Sub',
  '',
  'Sub StartGame()',
  '    nPlayer = 0 : nBall = 1 : nPlayers = 1',
  '    aScore(0) = 0',
  '    If ScorbitActive = 1 And Scorbit.bNeedsPairing = False Then',
  '        Scorbit.StartSession()',
  '    End If',
  'End Sub',
  '',
  'Sub AddScore (value)',
  '    aScore(nPlayer) = aScore(nPlayer) + value',
  '    If Not bShowPup Then Exit Sub',
  '    ShowScore',
  'End Sub',
  '',
  'Sub ShowScore()',
  'End Sub',
  '',
  'Sub EndBall',
  '    nBall = nBall + 1',
  '    If nBall > 3 Then FinishGame',
  'End Sub',
  '',
  'Sub FinishGame',
  '    nPlayers = 0',
  '    If Scorbit.bSessionActive Then',
  '        StopScorbit',
  '    End If',
  'End Sub',
  '',
  'Sub StopScorbit',
  '    Scorbit.StopSession aScore(0), aScore(1), aScore(2), aScore(3), nPlayers',
  'End Sub',
  '',
  'Class ScorbitIF',
  '    Public bNeedsPairing, bSessionActive',
  '    Public Sub StartSession()',
  '    End Sub',
  '    Public Sub StopSession(P1, P2, P3, P4, NumberPlayers)',
  '    End Sub',
  '    Public Sub SendUpdate(P1, P2, P3, P4, CurrentBall, CurrentPlayer, NumberPlayers)',
  '    End Sub',
  '    Sub DoTimer()',
  '        If bSessionActive Then Scorbit.SendUpdate aScore(0), aScore(1), aScore(2), aScore(3), nBall, nPlayer+1, nPlayers',
  '    End Sub',
  'End Class',
];

/**
 * A ScoreServer-integrated original (class D, recipe D), shaped like superhac's integration guide: the object made
 * once under `On Error Resume Next`, a report sub calling `SetGameState` then `SetScoresArray`, state 3 at game over
 * followed by the high scores and `ClearState`. Its game subs are not JPSalas-named, so it is not class B.
 */
export const SCORESERVER_D_SCRIPT = [
  'Option Explicit',
  'Dim ScoreServer, PlayerScore(4), Player, PlayerCount, BallNo',
  '',
  'Sub Table1_Init()',
  '    On Error Resume Next',
  '    Set ScoreServer = CreateObject("VPinball.ScoreServer")',
  '    On Error Goto 0',
  '    If IsObject(ScoreServer) Then ScoreServer.SetGameName "SyntheticTable"',
  'End Sub',
  '',
  'Sub Table1_KeyDown(ByVal keycode)',
  '    If keycode = StartGameKey Then BeginGame',
  'End Sub',
  '',
  'Sub BeginGame()',
  '    Player = 1 : PlayerCount = 1 : BallNo = 1 : PlayerScore(1) = 0',
  '    Report 1',
  'End Sub',
  '',
  'Sub Drained()',
  '    Report 2',
  '    BallNo = BallNo + 1',
  '    If BallNo > 3 Then GameOver',
  'End Sub',
  '',
  'Sub GameOver()',
  '    Report 3',
  '    If IsObject(ScoreServer) Then',
  '        ScoreServer.SetHighScoresArray "First|Second", "AAA|BBB", "100|50"',
  '        ScoreServer.ClearState',
  '    End If',
  'End Sub',
  '',
  'Sub Report(state)',
  '    If Not IsObject(ScoreServer) Then Exit Sub',
  '    Dim i, names(), values()',
  '    ReDim names(PlayerCount - 1) : ReDim values(PlayerCount - 1)',
  '    For i = 1 To PlayerCount',
  '        names(i - 1) = "Player " & i : values(i - 1) = FormatNumber(PlayerScore(i), 0, -1, 0, 0)',
  '    Next',
  '    ScoreServer.SetGameState PlayerCount, Player, BallNo, state',
  '    ScoreServer.SetScoresArray Join(names, "|"), _',
  '        Join(values, "|")',
  'End Sub',
];

/** A class-D script calling a method the shim does not have: recipe D must leave its ScoreServer alone. */
export const SCORESERVER_D_UNKNOWN_SCRIPT = [
  'Dim ScoreServer',
  'Sub Table1_Init()',
  '    On Error Resume Next',
  '    Set ScoreServer = CreateObject("VPinball.ScoreServer")',
  '    ScoreServer.SetGameName "x"',
  '    ScoreServer.SetHighScoresArray "a", "b"',
  '    ScoreServer.Reconnect',
  'End Sub',
  'Sub Table1_KeyDown(ByVal keycode)',
  'End Sub',
];

/** A generic original (class E): scores, but none of the anchors B/C/D need. */
export const ORIGINAL_E_SCRIPT = ['Dim Points', 'Sub Table1_KeyDown(ByVal keycode)', 'End Sub', 'Sub Bumper1_Hit()', '    Points = Points + 10', 'End Sub'];

/** A commented-out LoadVPM must not make an original a VPM table. */
export const COMMENTED_LOADVPM_SCRIPT = [
  "' LoadVPM \"01560000\", \"WPC.VBS\", 3.26",
  'Dim Score(4)',
  'Sub Table1_KeyDown(ByVal keycode)',
  'End Sub',
  'Sub ResetForNewGame()',
  'End Sub',
  'Sub AddScore(points)',
  'End Sub',
  'Sub EndOfGame()',
  'End Sub',
];

/** A test table without a key handler. */
export const NO_KEYDOWN_SCRIPT = ['Option Explicit', 'Sub Table1_Init', 'End Sub'];

/** A VPM table whose embedded script is already a Castcade sidecar. */
export const PATCHED_VPM_SCRIPT = [
  "' --- Castcade (recipe A v0.1.0, lib 0.1.0) --- do not edit; delete this .vbs to revert to the embedded script",
  'Castcade_Init "x", "A", "0.1.0", "mb_106b"',
  'Const cGameName = "mb_106b"',
  'LoadVPM "01560000", "WPC.VBS", 3.26',
  'Sub Castcade_Orig_KeyDown(ByVal keycode)',
  'End Sub',
  'Sub Table1_KeyDown(ByVal KeyCode)',
  '    Castcade_Orig_KeyDown KeyCode',
  'End Sub',
];

export const crlf = (lines: readonly string[]): string => lines.join('\r\n') + '\r\n';
export const lf = (lines: readonly string[]): string => lines.join('\n') + '\n';
