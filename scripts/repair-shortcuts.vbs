Option Explicit

' Point desktop, Start Menu, and taskbar ViewerOne shortcuts at ViewerOne-Launch.vbs
' so the pin runs the GitHub sync instead of a stale electron.exe.

Dim sh, fso, repo, vbs, icon, wscriptExe
Dim desktop, taskbar, startMenu

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count > 0 Then
  repo = WScript.Arguments(0)
Else
  repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
End If

vbs = repo & "\ViewerOne-Launch.vbs"
If Not fso.FileExists(vbs) Then WScript.Quit 1

icon = repo & "\build\icon.ico"
wscriptExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"

desktop = sh.SpecialFolders("Desktop")
startMenu = sh.SpecialFolders("Programs")
taskbar = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

FixFolder desktop
FixFolder startMenu
FixFolder taskbar

WScript.Quit 0

Sub FixFolder(folder)
  Dim lnk, sc, hay, file
  If folder = "" Then Exit Sub
  If Not fso.FolderExists(folder) Then Exit Sub

  For Each file In fso.GetFolder(folder).Files
    If LCase(fso.GetExtensionName(file.Name)) = "lnk" Then
      On Error Resume Next
      Set sc = sh.CreateShortcut(file.Path)
      hay = LCase(file.Name & " " & sc.TargetPath & " " & sc.Arguments)
      If InStr(hay, "viewerone") > 0 Or InStr(hay, "viewer-one") > 0 Then
        WriteShortcut file.Path
      End If
      On Error GoTo 0
    End If
  Next

  WriteShortcut folder & "\ViewerOne.lnk"
End Sub

Sub WriteShortcut(path)
  Dim sc
  On Error Resume Next
  Set sc = sh.CreateShortcut(path)
  sc.TargetPath = wscriptExe
  sc.Arguments = Chr(34) & vbs & Chr(34)
  sc.WorkingDirectory = repo
  sc.WindowStyle = 7
  sc.Description = "ViewerOne"
  If fso.FileExists(icon) Then sc.IconLocation = icon & ",0"
  sc.Save
  On Error GoTo 0
End Sub
