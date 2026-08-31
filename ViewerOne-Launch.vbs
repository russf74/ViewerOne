Option Explicit

Dim shell, fso, folder, batch, exitCode, logFile, logText, f

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
batch = folder & "\ViewerOne-Launch-Silent.cmd"
logFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"

If Not fso.FileExists(batch) Then
  MsgBox "ViewerOne launcher missing:" & vbCrLf & batch, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

exitCode = shell.Run(Chr(34) & batch & Chr(34), 0, True)

If exitCode <> 0 Then
  logText = "Log: " & logFile
  If fso.FileExists(logFile) Then
    Set f = fso.OpenTextFile(logFile, 1)
    logText = f.ReadAll
    f.Close
    If Len(logText) > 600 Then logText = "..." & Right(logText, 600)
  End If
  MsgBox "ViewerOne did not start." & vbCrLf & vbCrLf & logText, vbCritical, "ViewerOne"
End If
