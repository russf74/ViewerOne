Option Explicit

' Start X32-Edit, Cubase 15, and ViewerOne at Windows logon.
' Invoked by Task Scheduler "ViewerOne Gig Startup" (and start-gig-apps.cmd).
' Does not rebuild ViewerOne — launches electron.exe directly.
' Paths under the user profile work on the backup PC even if the account name differs.

Dim sh, fso, wmi
Dim userProfile, pf86
Dim xedit, cubase, viewerOneDir, loopMidiA, loopMidiB

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

userProfile = sh.ExpandEnvironmentStrings("%USERPROFILE%")
pf86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
If pf86 = "" Or pf86 = "%ProgramFiles(x86)%" Then pf86 = "C:\Program Files (x86)"

xedit = userProfile & "\Desktop\Apps\X32-Edit.exe"
cubase = "C:\Program Files\Steinberg\Cubase 15\Cubase15.exe"
viewerOneDir = userProfile & "\ViewerOne"
loopMidiA = "C:\Program Files\Tobias Erichsen\loopMIDI\loopMIDI.exe"
loopMidiB = pf86 & "\Tobias Erichsen\loopMIDI\loopMIDI.exe"

Function ProcessRunning(imageName)
  Dim col
  Set col = wmi.ExecQuery("Select ProcessId from Win32_Process Where Name='" & imageName & "'")
  ProcessRunning = (col.Count > 0)
End Function

Function ViewerOneRunning()
  Dim col, p, cmd
  ViewerOneRunning = False
  Set col = wmi.ExecQuery("Select CommandLine from Win32_Process Where Name='electron.exe'")
  For Each p In col
    If Not IsNull(p.CommandLine) Then
      cmd = LCase(p.CommandLine)
      If InStr(cmd, "\viewerone\") > 0 Then
        ViewerOneRunning = True
        Exit Function
      End If
    End If
  Next
End Function

Sub StartExe(imageName, exePath)
  If ProcessRunning(imageName) Then Exit Sub
  If Not fso.FileExists(exePath) Then Exit Sub
  sh.Run """" & exePath & """", 1, False
End Sub

If fso.FileExists(loopMidiA) Then
  StartExe "loopMIDI.exe", loopMidiA
ElseIf fso.FileExists(loopMidiB) Then
  StartExe "loopMIDI.exe", loopMidiB
End If

StartExe "X32-Edit.exe", xedit
WScript.Sleep 2000
StartExe "Cubase15.exe", cubase
WScript.Sleep 5000

If Not ViewerOneRunning() Then
  If fso.FileExists(viewerOneDir & "\node_modules\electron\dist\electron.exe") Then
    sh.CurrentDirectory = viewerOneDir
    sh.Run """" & viewerOneDir & "\node_modules\electron\dist\electron.exe"" .", 1, False
  End If
End If
