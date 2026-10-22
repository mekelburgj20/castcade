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
