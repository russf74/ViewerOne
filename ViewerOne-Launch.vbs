Option Explicit

' Always runs the latest bootstrap from GitHub — fixes shortcuts, syncs v6, builds, launches.
Dim sh, fso, scriptDir, repoRoot, repoFile, rawUrl, cmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = scriptDir
repoFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ViewerOne\repo.txt"
If fso.FileExists(repoFile) Then
  Dim tf
  Set tf = fso.OpenTextFile(repoFile, 1)
  repoRoot = Trim(tf.ReadAll())
  tf.Close
End If

rawUrl = "https://raw.githubusercontent.com/russf74/ViewerOne/cursor/sound-to-light-director-433b/scripts/remote-bootstrap.ps1"
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""& { $p=$env:TEMP+'\vo-bootstrap.ps1'; (New-Object Net.WebClient).DownloadFile('" & rawUrl & "',$p); & $p -RepoRoot '" & repoRoot & "' -Mode Launch }"""
sh.Run cmd, 0, True
