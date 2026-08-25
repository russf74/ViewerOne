ViewerOne gig backup (USB hard drive)
=====================================

Before each gig, copy the live rig onto the USB drive. On the backup PC,
apply that copy so Cubase, ViewerOne, loopMIDI, X32-Edit, and Windows
startup all match.

The backup PC must already have Cubase 15 and loopMIDI installed.
This does not install those programs — it updates projects, settings,
and ViewerOne.

------------------------------------------------
ON THE MAIN PC  (just before the gig)
------------------------------------------------

1. Plug in the USB hard drive. Wait until Windows shows a drive letter.
2. Double-click "Copy to Gig Backup" on the Desktop
   (or scripts\gig-backup\COPY-TO-BACKUP.cmd in ViewerOne).
3. If more than one extra drive is plugged in, type the drive letter.
4. Wait until it says Copy finished. Cubase projects are large (~40 GB)
   so the first copy can take a while; later copies only send changes.

You can also run COPY-TO-BACKUP.cmd from the USB drive itself after the
first copy has put the scripts there.

USB layout (created for you):

  COPY-TO-BACKUP.cmd          <- run on the main PC
  APPLY-ON-BACKUP-PC.cmd      <- run on the backup PC
  GigBackup\
    Payload\
      ViewerOne\              app (no git / old installers / debug dumps)
      ViewerOne-Config\       setlist + MIDI settings
      Cubase-Projects\        80s-00s and other Cubase folders
      Cubase-Settings\        Generic Remote, Port Setup, key commands
      loopMIDI\               virtual cable names
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
   - loopMIDI should show CubaseToViewerOne and ViewerOneToCubase
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
- loopMIDI installer (https://www.tobias-erichsen.de/software/loopmidi.html)
- VST instruments / Native Access libraries
- Node.js (only needed if Electron was not included in the copy)
