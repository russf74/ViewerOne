import { BrowserWindow, Menu, app, dialog } from 'electron'

const startHelp =
  '1. ESP32: Flash firmware/esp32-display, enable USB serial below (COM autodetect).\n\n' +
  '2. MIDI: Cubase ↔ ViewerOne over loopMIDI (auto-detected). Program Change channel is fixed (see midiConfig).\n\n' +
  '3. Setlist: Order = program numbers 1…125. Add songs; drag ⋮⋮ to reorder.\n\n' +
  '4. Cubase: Song PC updates the display only. PC 126 = dim knight rider (between songs). PC 127 = apply lights for the displayed song.\n\n' +
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
