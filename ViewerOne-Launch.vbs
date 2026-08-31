Option Explicit

' Repo copy of the stable bootstrap — delegates to %LOCALAPPDATA%\ViewerOne\ViewerOne-Launch.vbs
Dim sh, fso, bootstrap, repoBootstrap, url, ps1, cmd, repo
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bootstrap = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ViewerOne\ViewerOne-Launch.vbs"
repo = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\ViewerOne"
repoBootstrap = fso.GetParentFolderName(WScript.ScriptFullName) & "\scripts\bootstrap\ViewerOne-Launch.vbs"

If Not fso.FolderExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ViewerOne") Then
  fso.CreateFolder sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ViewerOne"
End If

If fso.FileExists(repoBootstrap) Then
  fso.CopyFile repoBootstrap, bootstrap, True
End If

If fso.FileExists(bootstrap) Then
  sh.Run """" & bootstrap & """", 0, True
Else
  url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/launch-viewerone.ps1"
  ps1 = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.ps1"
  cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""& { " & _
    "(New-Object Net.WebClient).DownloadFile('" & url & "','" & ps1 & "'); " & _
    "& '" & ps1 & "' -RepoRoot '" & repo & "' }"""
  sh.Run cmd, 0, True
End If
