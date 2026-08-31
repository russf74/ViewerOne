Option Explicit

' Silent launcher: build then open ViewerOne (no console window).
' Desktop shortcut should point to this file.

Dim sh, fso, scriptDir, electronExe, code, buildCmd, launchCmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

buildCmd = "cmd /c cd /d """ & scriptDir & """ && npm run build"
code = sh.Run(buildCmd, 0, True)

If code <> 0 Then
  MsgBox "ViewerOne could not build." & vbCrLf & vbCrLf & _
    "Open a terminal in the project folder and run: npm run build", _
    vbCritical, "ViewerOne"
  WScript.Quit code
End If

electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electronExe) Then
  MsgBox "Electron was not found under node_modules." & vbCrLf & vbCrLf & _
    "In the project folder run: npm install", vbCritical, "ViewerOne"
  WScript.Quit 1
End If

launchCmd = "cmd /c cd /d """ & scriptDir & """ && """ & electronExe & """ ."
sh.Run launchCmd, 0, False
