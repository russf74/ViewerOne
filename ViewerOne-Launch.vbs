Option Explicit

' Desktop / taskbar: build and open, same as before v6 shortcut experiments.
' Assignment to WScript.Shell.Run needs parentheses or VBScript errors
' "Expected end of statement".

Dim sh, fso, scriptDir, silentCmd, exitCode, logFile

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
silentCmd = scriptDir & "\ViewerOne-Launch-Silent.cmd"
logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"

If Not fso.FileExists(silentCmd) Then
  MsgBox "ViewerOne launcher missing:" & vbCrLf & silentCmd, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

exitCode = sh.Run(Chr(34) & silentCmd & Chr(34), 0, True)

If exitCode <> 0 Then
  MsgBox "ViewerOne could not start." & vbCrLf & vbCrLf & "Log: " & logFile, vbCritical, "ViewerOne"
  WScript.Quit exitCode
End If
