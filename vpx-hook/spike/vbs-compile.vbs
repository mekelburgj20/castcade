' vbs-compile.vbs -- compile ONE table script (or a rendered Castcade sidecar) with the Windows VBScript engine, the
' one VPX runs scripts with, WITHOUT running any of it.
'
'   cscript //nologo vbs-compile.vbs <script.vbs>
'
' The engine compiles a whole text before it executes the first statement, so the text is handed to ExecuteGlobal
' behind one line that raises error 999: a syntax error anywhere (or a name declared twice) is reported instead of
' 999, and a script that compiles stops at that first statement. Nothing of the table runs: no CreateObject, no file
' is touched. "Option Explicit" must be a script's first statement, so that line is blanked (line numbers are kept).
' One script per process: ExecuteGlobal declares the script's names in this engine, so a second script would collide.
'
' Prints  OK <file>  (exit 0)  or  SYNTAX <file>: <source> <number>: <description>  (exit 1).
Dim vbc__fso, vbc__path, vbc__text, vbc__re, vbc__num, vbc__src, vbc__desc
If WScript.Arguments.Count <> 1 Then
    WScript.Echo "usage: cscript //nologo vbs-compile.vbs <script.vbs>"
    WScript.Quit 2
End If
vbc__path = WScript.Arguments(0)
Set vbc__fso = CreateObject("Scripting.FileSystemObject")
If Not vbc__fso.FileExists(vbc__path) Then
    WScript.Echo "MISSING " & vbc__path
    WScript.Quit 2
End If
vbc__text = ""
If vbc__fso.GetFile(vbc__path).Size > 0 Then vbc__text = vbc__fso.OpenTextFile(vbc__path, 1, False, 0).ReadAll
Set vbc__re = New RegExp
vbc__re.IgnoreCase = True
vbc__re.Multiline = True
vbc__re.Global = False
vbc__re.Pattern = "^([ \t]*)Option[ \t]+Explicit\b"
vbc__text = vbc__re.Replace(vbc__text, "$1")
On Error Resume Next
Err.Clear
ExecuteGlobal "Err.Raise 999" & vbCrLf & vbc__text
vbc__num = Err.Number : vbc__src = Err.Source : vbc__desc = Err.Description
On Error Goto 0
If vbc__num = 999 Then
    WScript.Echo "OK " & vbc__path
    WScript.Quit 0
End If
WScript.Echo "SYNTAX " & vbc__path & ": " & vbc__src & " " & vbc__num & ": " & vbc__desc
WScript.Quit 1
