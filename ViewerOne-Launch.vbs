Option Explicit

' Download latest silent launcher (cache-busted), show the updater window,
' close old ViewerOne, sync GitHub, then open the new build.

Dim shell, fso, repo, cmdPath, runPath, url, http, stream, tempDir, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = repo & "\ViewerOne-Launch-Silent.cmd"
tempDir = shell.ExpandEnvironmentStrings("%TEMP%")
runPath = tempDir & "\viewerone-launch-run.cmd"
url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/ViewerOne-Launch-Silent.cmd?v=6.00.04"

On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
If http Is Nothing Then Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Not http Is Nothing Then
  http.Open "GET", url, False
  http.SetRequestHeader "Cache-Control", "no-cache"
  http.Send
  If http.Status = 200 Then
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1
    stream.Open
    stream.Write http.responseBody
    stream.SaveToFile cmdPath, 2
    stream.Close
  End If
End If
On Error GoTo 0

If Not fso.FileExists(cmdPath) Then
  MsgBox "ViewerOne launcher missing:" & vbCrLf & cmdPath, vbCritical, "ViewerOne"
  WScript.Quit 1
End If

fso.CopyFile cmdPath, runPath, True
' Window style 1 = visible so the update is not silent/instant.
exitCode = shell.Run("cmd.exe /c """ & runPath & """ """ & repo & """", 1, True)
If exitCode <> 0 Then
  MsgBox "ViewerOne update did not finish." & vbCrLf & "Log: " & tempDir & "\viewerone-launch.log", vbCritical, "ViewerOne"
  WScript.Quit exitCode
End If
