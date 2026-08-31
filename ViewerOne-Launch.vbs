Option Explicit

' Desktop / taskbar entry point.
' Capturing WScript.Shell.Run's exit code REQUIRES parentheses:
'   exitCode = sh.Run(command, windowStyle, wait)
' Without parentheses VBScript raises "Expected end of statement" at the Run call.

Dim sh, fso, scriptDir, silentCmd, exitCode, logFile, reason

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
silentCmd = scriptDir & "\ViewerOne-Launch-Silent.cmd"
logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"

If Not fso.FileExists(silentCmd) Then
  MsgBox "ViewerOne-Launch-Silent.cmd is missing in:" & vbCrLf & scriptDir & vbCrLf & vbCrLf & _
    "Double-click ViewerOne-Fix.cmd in that folder, or run scripts\fix-viewerone.ps1.", _
    vbCritical, "ViewerOne"
  WScript.Quit 1
End If

exitCode = sh.Run(Chr(34) & silentCmd & Chr(34), 0, True)

If exitCode <> 0 Then
  Select Case exitCode
    Case 1
      reason = "Node.js / npm was not found. Install Node.js LTS from https://nodejs.org"
    Case 2
      reason = "npm install failed."
    Case 3
      reason = "App build failed."
    Case 4
      reason = "electron.exe is missing after build."
    Case Else
      reason = "Launch failed."
  End Select

  MsgBox "ViewerOne could not start." & vbCrLf & vbCrLf & _
    reason & vbCrLf & vbCrLf & _
    "Exit code: " & exitCode & vbCrLf & _
    "Log: " & logFile & vbCrLf & vbCrLf & _
    "Fix: double-click ViewerOne-Fix.cmd in:" & vbCrLf & scriptDir, _
    vbCritical, "ViewerOne"
  WScript.Quit exitCode
End If
