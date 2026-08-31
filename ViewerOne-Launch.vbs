Option Explicit

Dim shell, fso, repo, cmdPath, runPath, url, http, stream, tempDir, exitCode, wmi, col, p, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = repo & "\ViewerOne-Launch-Silent.cmd"
tempDir = shell.ExpandEnvironmentStrings("%TEMP%")
runPath = tempDir & "\viewerone-launch-run.cmd"
url = "https://raw.githubusercontent.com/russf74/ViewerOne/main/ViewerOne-Launch-Silent.cmd"

On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set col = wmi.ExecQuery("Select ProcessId, CommandLine From Win32_Process Where Name='electron.exe' OR Name='ViewerOne.exe'")
For Each p In col
  cmd = LCase("" & p.CommandLine & " " & p.Name)
  If InStr(cmd, "viewerone") > 0 Or LCase(p.Name) = "viewerone.exe" Then
    wmi.Get("Win32_Process.Handle='" & p.ProcessId & "'").Terminate 0
  End If
Next
On Error GoTo 0
WScript.Sleep 800

On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
If http Is Nothing Then Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Not http Is Nothing Then
  http.Open "GET", url, False
  http.SetRequestHeader "Cache-Control", "no-cache"
  http.SetRequestHeader "Pragma", "no-cache"
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
exitCode = shell.Run("cmd.exe /c """ & runPath & """ """ & repo & """", 1, True)
If exitCode <> 0 Then
  MsgBox "ViewerOne update did not finish." & vbCrLf & "Log: " & tempDir & "\viewerone-launch.log", vbCritical, "ViewerOne"
  WScript.Quit exitCode
End If
