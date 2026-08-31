Option Explicit

' Downloads the latest launch script from GitHub every click — works even if this local file is old.
Dim sh, repo, url, ps1, cmd
Set sh = CreateObject("WScript.Shell")
repo = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/launch-from-github.ps1"
ps1 = sh.ExpandEnvironmentStrings("%TEMP%") & "\viewerone-launch.ps1"

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""& { " & _
  "try { (New-Object Net.WebClient).DownloadFile('" & url & "','" & ps1 & "') } catch { " & _
  "MsgBox 'ViewerOne could not reach GitHub.' & vbCrLf & vbCrLf & 'Check internet connection.', vbCritical, 'ViewerOne': WScript.Quit 1 }; " & _
  "& '" & ps1 & "' -RepoRoot '" & repo & "' }"""

sh.Run cmd, 0, True
