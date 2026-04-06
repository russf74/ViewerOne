import { BrowserWindow, Menu, app, dialog } from 'electron'

const startHelp =
  '1. MIDI: Create a virtual cable (e.g. loopMIDI). In this window, pick Input (from Cubase) and Output (back to Cubase). Set the Program Change channel to match Cubase.\n\n' +
  '2. Setlist: Order = program numbers 1, 2, 3… (Cubase program N matches PC N; raw MIDI byte is offset +1). Add songs at the bottom; drag ⋮⋮ to reorder.\n\n' +
  '3. Display: Use Display → Open fullscreen on second monitor for the touch screen.\n\n' +
  '4. Cubase: Send program changes on that channel; map MIDI Remote to Start/Stop notes if using note mode.\n\n' +
  'Tip: View → Toggle Developer Tools if something looks wrong.'

export function setupAppMenu(handlers: {
  openDisplay: () => void
  hideDisplay: () => void
}): void {
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
      label: 'Display',
      submenu: [
        {
          label: 'Open fullscreen on second monitor',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => handlers.openDisplay()
        },
        {
          label: 'Hide display window',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => handlers.hideDisplay()
        }
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
