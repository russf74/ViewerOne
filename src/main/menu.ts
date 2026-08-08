import { BrowserWindow, Menu, app, dialog } from 'electron'

const startHelp =
  '1. ESP32: Flash firmware/esp32-display, enable USB serial below (COM autodetect).\n\n' +
  '2. MIDI: Cubase ↔ ViewerOne over loopMIDI (auto-detected). Program Change channel is fixed (see midiConfig).\n\n' +
  '3. Setlist: Order = program numbers 1…119. Add songs; drag ⋮⋮ to reorder.\n\n' +
  '4. Cubase: Song PC updates the display only. CrowPanel SYNTH/PIANO pads send ch1 CC86/CC87 mute (127=muted, 0=live; inverted vs FX CC85) on ViewerOneToCubase — map Jump/Value Generic Remote to mixer ch1/ch2 Mute. PC 125 = blackout. PC 126 = dim knight rider (between songs). PC 127 = apply lights for the displayed song.\n\n' +
  '5. Countdown / transport: MIDI Clock Start/Continue/Stop (0xFA/0xFB/0xFC) start/freeze/resume the remaining-time countdown (wall-clock while Playing; light tempo nudge only). MMC Play/Stop and mapped notes/CCs also work (default ch16 note 60/61 — Detail → Transport MIDI). Stop freezes remaining; Continue/Start after Stop resumes; Start while running or rewind to bar 1 resets. Route MIDI Clock to CubaseToViewerOne (Always Send Start Message on). Filter spy: Transport only.\n\n' +
  'Tip: View → Toggle Developer Tools if something looks wrong.'

export function setupAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Exit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force reload' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual size' },
        { role: 'zoomIn', label: 'Zoom in' },
        { role: 'zoomOut', label: 'Zoom out' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'How to start…',
          click: () => {
            const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
            void dialog.showMessageBox(parent, {
              type: 'info',
              title: 'ViewerOne — Quick start',
              message: 'Getting started',
              detail: startHelp,
              noLink: true
            })
          }
        }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
