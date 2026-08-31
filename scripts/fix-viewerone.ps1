# One-time fix: download latest launcher from GitHub and open ViewerOne v6.
$RepoRoot = Join-Path $env:USERPROFILE 'ViewerOne'
$VbsDest = Join-Path $RepoRoot 'ViewerOne-Launch.vbs'
$Url = 'https://raw.githubusercontent.com/russf74/ViewerOne/main/ViewerOne-Launch.vbs'

Write-Host "Downloading latest launcher..."
(New-Object Net.WebClient).DownloadFile($Url, $VbsDest)
Write-Host "Launching ViewerOne..."
Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$VbsDest`""
