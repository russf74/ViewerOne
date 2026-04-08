import { BrowserWindow, Menu, app, dialog } from 'electron'

const startHelp =
  '1. ESP32: Flash firmware/esp32-display, enable the pocket display below, pick your COM port.\n\n' +
  '2. MIDI: Pick Input (from Cubase) and Output (back to Cubase) if you use program changes from Cubase. Set the Program Change channel to match.\n\n' +
  '3. Setlist: Order = program numbers 1, 2, 3… Add songs; drag ⋮⋮ to reorder.\n\n' +
  '4. Cubase: Send program changes on that channel when using MIDI follow.\n\n' +
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
