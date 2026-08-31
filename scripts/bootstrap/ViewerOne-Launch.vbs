Option Explicit

' Stable launcher stub — lives in %LOCALAPPDATA%\ViewerOne\ (outside the git repo).
' Desktop/taskbar shortcuts should point here. Always pulls the latest launcher from GitHub.
Dim sh, repo, url, ps1, cmd
Set sh = CreateObject("WScript.Shell")
repo = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\ViewerOne"
url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/launch-viewerone.ps1"
ps1 = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.ps1"

On Error Resume Next
CreateObject("Scripting.FileSystemObject").CreateFolder sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ViewerOne"
On Error GoTo 0

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""& { " & _
  "try { (New-Object Net.WebClient).DownloadFile('" & url & "','" & ps1 & "') } catch { exit 1 }; " & _
  "& '" & ps1 & "' -RepoRoot '" & repo & "' }"""
sh.Run cmd, 0, True
