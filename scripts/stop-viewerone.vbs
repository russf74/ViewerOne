Option Explicit

' Close ViewerOne's electron.exe so git can update files and a new build can start.
Dim wmi, col, p, cmd, wsh
Set wsh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set col = wmi.ExecQuery("Select ProcessId, CommandLine From Win32_Process Where Name='electron.exe'")
For Each p In col
  If Not IsNull(p.CommandLine) Then
    cmd = LCase(p.CommandLine)
    If InStr(cmd, "viewerone") > 0 Then
      On Error Resume Next
      wmi.Get("Win32_Process.Handle='" & p.ProcessId & "'").Terminate 0
      On Error GoTo 0
    End If
  End If
Next
WScript.Sleep 1500
