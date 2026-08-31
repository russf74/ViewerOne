Option Explicit

' Silent launcher: sync repo, fix shortcuts, build, open ViewerOne.
' Desktop / taskbar shortcut should point here via wscript.exe.

Dim sh, fso, scriptDir, electronExe, code, syncCmd, buildCmd, launchCmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Match GitHub main (silent — ok if offline).
syncCmd = "cmd /c cd /d """ & scriptDir & """ && git fetch origin main 2>nul && git reset --hard origin/main 2>nul"
sh.Run syncCmd, 0, True

' Retarget desktop + taskbar pins if they drifted to an old installed .exe.
If fso.FileExists(scriptDir & "\scripts\sync-viewerone.ps1") Then
  sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\scripts\sync-viewerone.ps1""", 0, True
End If

If Not fso.FolderExists(scriptDir & "\node_modules") Then
  sh.Run "cmd /c cd /d """ & scriptDir & """ && npm install --no-fund --no-audit", 0, True
End If

buildCmd = "cmd /c cd /d """ & scriptDir & """ && npm run build"
code = sh.Run(buildCmd, 0, True)

If code <> 0 Then
  MsgBox "ViewerOne could not build." & vbCrLf & vbCrLf & _
    "Folder: " & scriptDir, vbCritical, "ViewerOne"
  WScript.Quit code
End If

electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electronExe) Then
  MsgBox "Electron not found — run npm install in:" & vbCrLf & scriptDir, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

launchCmd = "cmd /c cd /d """ & scriptDir & """ && """ & electronExe & """ ."
sh.Run launchCmd, 0, False
