import { app, BrowserWindow, ipcMain } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppStore, getState, setState, newSetlistItem } from './store.js'
import { MidiService, listInputs, listOutputs } from './midi.js'
import {
  listSerialPorts,
  pushEsp32Payload,
  setEsp32SerialPort,
  shutdownEsp32Serial
} from './esp32Bridge.js'
import { buildEsp32DisplayPayload } from '../shared/esp32Payload.js'
import { ensureLoopMidiRunning } from './loopMidi.js'
import type { AppState, PublicState, SetlistItem } from '../shared/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function preloadScriptPath(): string {
  const mjs = join(__dirname, '../preload/index.mjs')
  if (existsSync(mjs)) return mjs
  return join(__dirname, '../preload/index.js')
}

let controlWindow: BrowserWindow | null = null
const store = createAppStore()
const midi = new MidiService()

function buildPublicState(): PublicState {
  const base = getState(store)
  return {
    ...base,
    inputs: listInputs(),
    outputs: listOutputs(),
    appVersion: app.getVersion()
  }
}

function broadcastEsp32IfEnabled(): void {
  const st = getState(store)
  if (!st.esp32Enabled || !st.esp32SerialPort) return
  pushEsp32Payload(buildEsp32DisplayPayload(st))
}

function syncEsp32SerialFromStore(): void {
  const st = getState(store)
  if (st.esp32Enabled && st.esp32SerialPort) {
    setEsp32SerialPort(st.esp32SerialPort, () => broadcastEsp32IfEnabled())
  } else {
    setEsp32SerialPort(null)
  }
}

function broadcastState(): void {
  const payload = buildPublicState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('state:update', payload)
  }
  broadcastEsp32IfEnabled()
}

function applyMidiFromState(): void {
  const st = getState(store)
  midi.reconnectFromState(st, {
    onProgramChange: (wireProgram) => {
      const s = getState(store)
      const pc = Math.min(127, wireProgram + 1)
      const row = s.setlist.find((r) => r.program === pc)
      if (row) {
        setState(store, { currentSongId: row.id })
        broadcastState()
      }
    }
  })
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 800,
    minWidth: 560,
    minHeight: 520,
    show: true,
    title: `ViewerOne v${app.getVersion()} — Control`,
    webPreferences: {
      preload: preloadScriptPath(),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/, '')
    void win.loadURL(`${base}/control/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/control/index.html'))
  }

  win.on('closed', () => {
    controlWindow = null
  })

  return win
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => buildPublicState())

  ipcMain.handle('setlist:set', (_e, items: SetlistItem[]) => {
    if (!Array.isArray(items)) return buildPublicState()
    const withIds = items.map((row) => ({
      id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
      program: 0,
      title: String(row.title ?? ''),
      chords: String(row.chords ?? ''),
      live: typeof row.live === 'boolean' ? row.live : true
    }))
    const normalized = assignProgramsByOrder(withIds)
    const st = getState(store)
    const still =
      st.currentSongId && normalized.some((r) => r.id === st.currentSongId)
        ? st.currentSongId
        : null
    setState(store, { setlist: normalized, currentSongId: still })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:add', () => {
    const st = getState(store)
    const next = assignProgramsByOrder([...st.setlist, newSetlistItem({})])
    setState(store, { setlist: next })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:remove', (_e, id: string) => {
    const st = getState(store)
    const filtered = st.setlist.filter((r) => r.id !== id)
    const next = assignProgramsByOrder(filtered)
    const nextSong = st.currentSongId === id ? null : st.currentSongId
    setState(store, { setlist: next, currentSongId: nextSong })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('settings:patch', (_e, patch: Partial<AppState>) => {
    if (!patch || typeof patch !== 'object') return buildPublicState()
    const allowed: Partial<AppState> = {}
    if (patch.midiInputName !== undefined) allowed.midiInputName = patch.midiInputName
    if (patch.midiOutputName !== undefined) allowed.midiOutputName = patch.midiOutputName
    if (patch.programChangeChannel !== undefined) {
      allowed.programChangeChannel = clampInt(patch.programChangeChannel, 1, 16)
    }
    if (patch.esp32SerialPort !== undefined) {
      allowed.esp32SerialPort =
        typeof patch.esp32SerialPort === 'string' && patch.esp32SerialPort.trim()
          ? patch.esp32SerialPort.trim()
          : null
    }
    if (patch.esp32Enabled !== undefined) allowed.esp32Enabled = Boolean(patch.esp32Enabled)
    setState(store, allowed)
    if (
      allowed.midiInputName !== undefined ||
      allowed.midiOutputName !== undefined ||
      allowed.programChangeChannel !== undefined
    ) {
      applyMidiFromState()
    }
    if (allowed.esp32SerialPort !== undefined || allowed.esp32Enabled !== undefined) {
      syncEsp32SerialFromStore()
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('midi:refresh', () => {
    applyMidiFromState()
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('esp32:listPorts', async () => {
    try {
      return await listSerialPorts()
    } catch {
      return []
    }
  })

  ipcMain.handle('setlist:prevSong', () => {
    const st = getState(store)
    const { setlist } = st
    if (setlist.length === 0) return buildPublicState()
    const idx = st.currentSongId ? setlist.findIndex((r) => r.id === st.currentSongId) : -1
    let nextIdx: number | null = null
    if (idx > 0) nextIdx = idx - 1
    else if (idx === -1) nextIdx = setlist.length - 1
    if (nextIdx === null) return buildPublicState()
    const row = setlist[nextIdx]
    setState(store, { currentSongId: row.id })
    midi.sendProgramChange(st.programChangeChannel, row.program)
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:nextSong', () => {
    const st = getState(store)
    const { setlist } = st
    if (setlist.length === 0) return buildPublicState()
    const idx = st.currentSongId ? setlist.findIndex((r) => r.id === st.currentSongId) : -1
    let nextIdx: number | null = null
    if (idx >= 0 && idx < setlist.length - 1) nextIdx = idx + 1
    else if (idx === -1) nextIdx = 0
    if (nextIdx === null) return buildPublicState()
    const row = setlist[nextIdx]
    setState(store, { currentSongId: row.id })
    midi.sendProgramChange(st.programChangeChannel, row.program)
    broadcastState()
    return buildPublicState()
  })

  /** Move current song for ESP / UI preview only — does not send MIDI program change. */
  ipcMain.handle('setlist:previewPrev', () => {
    const st = getState(store)
    const { setlist } = st
    if (setlist.length === 0) return buildPublicState()
    const idx = st.currentSongId ? setlist.findIndex((r) => r.id === st.currentSongId) : -1
    let nextIdx: number | null = null
    if (idx > 0) nextIdx = idx - 1
    else if (idx === -1) nextIdx = setlist.length - 1
    if (nextIdx === null) return buildPublicState()
    setState(store, { currentSongId: setlist[nextIdx].id })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:previewNext', () => {
    const st = getState(store)
    const { setlist } = st
    if (setlist.length === 0) return buildPublicState()
    const idx = st.currentSongId ? setlist.findIndex((r) => r.id === st.currentSongId) : -1
    let nextIdx: number | null = null
    if (idx >= 0 && idx < setlist.length - 1) nextIdx = idx + 1
    else if (idx === -1) nextIdx = 0
    if (nextIdx === null) return buildPublicState()
    setState(store, { currentSongId: setlist[nextIdx].id })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:selectSong', (_e, id: unknown) => {
    const st = getState(store)
    if (id === null || id === undefined || id === '') {
      setState(store, { currentSongId: null })
      broadcastState()
      return buildPublicState()
    }
    if (typeof id !== 'string') return buildPublicState()
    if (!st.setlist.some((r) => r.id === id)) return buildPublicState()
    setState(store, { currentSongId: id })
    broadcastState()
    return buildPublicState()
  })
}

/** Program numbers follow setlist order: row i → PC = min(i + 1, 127) (1-based for Cubase). */
function assignProgramsByOrder(items: SetlistItem[]): SetlistItem[] {
  return items.map((row, i) => ({
    ...row,
    program: Math.min(127, i + 1)
  }))
}

function programsMatchListOrder(items: SetlistItem[]): boolean {
  return items.every((row, i) => row.program === Math.min(127, i + 1))
}

function clampInt(n: number, min: number, max: number): number {
  const x = Math.trunc(Number(n))
  if (Number.isNaN(x)) return min
  return Math.max(min, Math.min(max, x))
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      if (controlWindow.isMinimized()) controlWindow.restore()
      controlWindow.show()
      controlWindow.focus()
    }
  })

  app.whenReady().then(() => {
    ensureLoopMidiRunning()
    registerIpc()
    const initial = getState(store)
    if (!programsMatchListOrder(initial.setlist)) {
      setState(store, { setlist: assignProgramsByOrder(initial.setlist) })
    }
    applyMidiFromState()
    syncEsp32SerialFromStore()
    setupAppMenu()
    controlWindow = createControlWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        controlWindow = createControlWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      midi.closeInput()
      midi.closeOutput()
      app.quit()
    }
  })

  app.on('before-quit', () => {
    shutdownEsp32Serial()
    midi.closeInput()
    midi.closeOutput()
  })
}
