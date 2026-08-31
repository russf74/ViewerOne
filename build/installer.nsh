!macro customInstall
  DetailPrint "Repairing ViewerOne desktop and taskbar shortcuts..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $$repo=$$env:USERPROFILE + \'\ViewerOne\'; $$boot=$$env:LOCALAPPDATA + \'\ViewerOne\ViewerOne-Launch.vbs\'; $$url=\'https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/remote-bootstrap.ps1\'; $$p=$$env:TEMP+\'\vo-bootstrap.ps1\'; (New-Object Net.WebClient).DownloadFile($$url,$$p); if (Test-Path $$repo) { & $$p -RepoRoot $$repo -Mode SyncOnly } else { & $$p -Mode SyncOnly } }"'
!macroend

!macro customInit
  DetailPrint "ViewerOne v6 — preparing shortcut repair..."
!macroend
