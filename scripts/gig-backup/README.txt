ViewerOne gig backup (USB hard drive)
=====================================

Before each gig, copy the live rig onto the USB drive. On the backup PC,
apply that copy so Cubase, ViewerOne, loopMIDI, X32-Edit, and Windows
startup all match.

The backup PC must already have Cubase 15 installed.
This does not install Cubase or the VST sample libraries themselves.
It does copy loopMIDI's program files, X32-Edit, ViewerOne (including
the Electron app), and the settings those programs need.

------------------------------------------------
ON THE MAIN PC  (just before the gig)
------------------------------------------------

1. Plug in the USB hard drive. Wait until Windows shows a drive letter.
2. Double-click "Copy to Gig Backup" on the Desktop
   (or scripts\gig-backup\COPY-TO-BACKUP.cmd in ViewerOne).
3. Choose:
     1  Full wipe and backup
        Erases the USB drive, then copies every file. Use this after
        major show changes. Nothing is skipped.
     2  Incremental
        Updates the existing backup. Caches and old debug dumps are skipped.
4. If more than one extra drive is plugged in, type the drive letter.
5. Wait until it says Copy finished. A full copy is about 100 GB
   (Cubase projects, Steinberg content, ViewerOne). Later incremental
   copies only send changes.

You can also run COPY-TO-BACKUP.cmd from the USB drive itself after the
first copy has put the scripts there.

USB layout (created for you):

  COPY-TO-BACKUP.cmd          <- run on the main PC
  APPLY-ON-BACKUP-PC.cmd      <- run on the backup PC
  GigBackup\
    Payload\
      ViewerOne\              the app, including Electron
      ViewerOne-AppData\      setlist, DMX programs, captured audio
      Cubase-Projects\        80s-00s and the other Cubase folders
      Steinberg-AppData\      Cubase 15 prefs, Generic Remote, key commands
      Steinberg-Documents\    MIDI Remote devices, user presets
      Steinberg-Local\        MediaBay local data
      Steinberg-ProgramData\  Steinberg content installed on this PC
      NativeInstruments-AppData\
      loopMIDI\               the program plus the cable names
      Startup\                logon script
      X32-Edit\               editor + scenes/prefs
    LAST-COPY.txt
    manifest.json

------------------------------------------------
ON THE BACKUP PC
------------------------------------------------

1. Plug in the same USB hard drive.
2. Double-click APPLY-ON-BACKUP-PC.cmd on the USB (root of the drive).
3. Close Cubase / ViewerOne / X32-Edit when asked.
4. When it finishes:
   - loopMIDI shows CubaseToViewerOne and ViewerOneToCubase
   - Open the latest 80s-00s .cpr it prints
   - Start ViewerOne from the desktop shortcut
   - Check MIDI in ViewerOne

If the backup PC Windows account is not the same as the main PC
(C:\Users\pc), Cubase projects go to Documents\Cubase. If Cubase then
asks for missing audio, point it at that folder.

If the backup PC audio interface is different, re-select it in Cubase
Studio Setup. MIDI routing is copied and should just work once loopMIDI
is running.

Logon startup: the "ViewerOne Gig Startup" task is created for whatever
user you are logged in as (loopMIDI, X32-Edit, Cubase, ViewerOne).

------------------------------------------------
NOT copied (install separately if missing)
------------------------------------------------

- Cubase 15 itself
- Native Instruments sample libraries (Kontakt, Guitar Rig content)
- Node.js (only needed if Electron was not included in the copy)
