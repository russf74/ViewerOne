Option Explicit

Dim shell, folder, batch, exitCode, logFile

Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
batch = folder & "\ViewerOne-Launch-Silent.cmd"
logFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"

If Not CreateObject("Scripting.FileSystemObject").FileExists(batch) Then
  MsgBox "ViewerOne launcher missing:" & vbCrLf & batch, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

exitCode = shell.Run(Chr(34) & batch & Chr(34), 0, True)

If exitCode <> 0 Then
  MsgBox "ViewerOne did not start." & vbCrLf & vbCrLf & "Log: " & logFile, vbCritical, "ViewerOne"
End If
