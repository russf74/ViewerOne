Option Explicit

' Silent launcher: build then open ViewerOne (no console window).
' Desktop shortcut points here via wscript.exe.

Dim sh, fso, scriptDir, electronExe, code, buildCmd, launchCmd, pullCmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Pull latest from GitHub (silent — ignore errors if offline).
pullCmd = "cmd /c cd /d """ & scriptDir & """ && git pull --ff-only origin main 2>nul"
sh.Run pullCmd, 0, True

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
