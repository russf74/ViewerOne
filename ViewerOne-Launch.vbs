Option Explicit

' Silent launcher: sync, build, open. Errors go to %TEMP%\viewerone-launch.log
Dim sh, fso, scriptDir, logFile, ps1, cmd, code

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.log"
ps1 = scriptDir & "\scripts\fix-viewerone.ps1"

If fso.FileExists(ps1) Then
  cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -RepoRoot """ & scriptDir & """"
Else
  cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ""& { " & _
    "$u='https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/fix-viewerone.ps1'; " & _
    "$p=$env:TEMP+'\viewerone-fix.ps1'; " & _
    "(New-Object Net.WebClient).DownloadFile($u,$p); " & _
    "& $p -RepoRoot '" & scriptDir & "' }"""
End If

code = sh.Run cmd, 1, True
If code <> 0 Then
  MsgBox "ViewerOne did not start." & vbCrLf & vbCrLf & _
    "Check the log:" & vbCrLf & logFile, vbCritical, "ViewerOne"
End If
