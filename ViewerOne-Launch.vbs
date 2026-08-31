Option Explicit

' Desktop/taskbar shortcut entry - fast build and open (no git sync).
Dim sh, fso, scriptDir, ps1, cmd, code, logFile

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\scripts\launch-viewerone.ps1"
logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"

If fso.FileExists(ps1) Then
  cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -RepoRoot """ & scriptDir & """"
Else
  MsgBox "ViewerOne launcher script missing:" & vbCrLf & ps1, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

code = sh.Run cmd, 0, True
If code <> 0 Then
  MsgBox "ViewerOne did not start." & vbCrLf & vbCrLf & "Log: " & logFile, vbCritical, "ViewerOne"
End If
