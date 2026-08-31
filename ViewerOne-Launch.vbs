Option Explicit

' Silent launcher: sync repo, refresh shortcuts, build, open ViewerOne (no console).
' Desktop + taskbar pins are updated automatically on every launch.

Dim sh, fso, scriptDir, pullCmd, ps1, buildCmd, electronExe, launchCmd, code

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Pull latest code (feature branch first, then main).
pullCmd = "cmd /c cd /d """ & scriptDir & """ && git pull --ff-only origin cursor/sound-to-light-director-433b 2>nul || git pull --ff-only origin main 2>nul"
sh.Run pullCmd, 0, True

' Refresh Desktop + taskbar + Start Menu shortcuts (best effort).
ps1 = scriptDir & "\scripts\install-viewerone-shortcut.ps1"
If fso.FileExists(ps1) Then
  sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, True
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
  MsgBox "Electron was not found under node_modules." & vbCrLf & vbCrLf & _
    "Folder: " & scriptDir, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

launchCmd = "cmd /c cd /d """ & scriptDir & """ && """ & electronExe & """ ."
sh.Run launchCmd, 0, False
