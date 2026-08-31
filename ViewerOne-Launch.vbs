Option Explicit

' Download latest silent launcher, run a TEMP copy (so git reset cannot
' rewrite the running script), then that copy syncs GitHub and opens ViewerOne.

Dim shell, fso, repo, cmdPath, runPath, url, http, stream, tempDir

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = repo & "\ViewerOne-Launch-Silent.cmd"
tempDir = shell.ExpandEnvironmentStrings("%TEMP%")
runPath = tempDir & "\viewerone-launch-run.cmd"
url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/ViewerOne-Launch-Silent.cmd"

On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
If http Is Nothing Then Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Not http Is Nothing Then
  http.Open "GET", url, False
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

If fso.FileExists(cmdPath) Then
  fso.CopyFile cmdPath, runPath, True
  shell.Run "cmd.exe /c """ & runPath & """ """ & repo & """", 0, False
End If
