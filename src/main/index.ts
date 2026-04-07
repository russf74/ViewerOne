import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppStore, getState, setState, newSetlistItem } from './store.js'
import { MidiService, listInputs, listOutputs, parseMmcTransportCommand } from './midi.js'
import { ensureLoopMidiRunning } from './loopMidi.js'
import type { AppState, CcButtonSettings, PublicState, SetlistItem } from '../shared/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function preloadScriptPath(): string {
  const mjs = join(__dirname, '../preload/index.mjs')
  if (existsSync(mjs)) return mjs
  return join(__dirname, '../preload/index.js')
}

let controlWindow: BrowserWindow | null = null
let displayWindow: BrowserWindow | null = null
const store = createAppStore()
const midi = new MidiService()

let muteAllEngaged = false
let muteFxEngaged = false
let transportPlaying = false

function buildPublicState(): PublicState {
  const base = getState(store)
  return {
    ...base,
    inputs: listInputs(),
    outputs: listOutputs(),
    muteAllEngaged,
    muteFxEngaged,
    transportPlaying,
    appVersion: app.getVersion()
  }
}

function broadcastState(): void {
  const payload = buildPublicState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('state:update', payload)
  }
}

function ch0Matches(msgCh0: number, settingsCh1to16: number): boolean {
  return msgCh0 === Math.max(0, Math.min(15, settingsCh1to16 - 1))
}

/** True = mute engaged (channels muted). Supports both polarities: 127/0 or 0/127 (X32 often uses 0=muted). */
function engagedFromCcValue(settings: CcButtonSettings, value: number): boolean {
  if (value === settings.valueOn) return true
  if (value === settings.valueOff) return false
  if (settings.valueOn > settings.valueOff) return value >= 64
  return value < 64
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
    },
    onCc: (msg) => {
      const s = getState(store)
      if (ch0Matches(msg.channel, s.muteAll.channel) && msg.controller === s.muteAll.cc) {
        const next = engagedFromCcValue(s.muteAll, msg.value)
        if (next !== muteAllEngaged) {
          muteAllEngaged = next
          broadcastState()
        }
      }
      if (ch0Matches(msg.channel, s.muteFx.channel) && msg.controller === s.muteFx.cc) {
        const next = engagedFromCcValue(s.muteFx, msg.value)
        if (next !== muteFxEngaged) {
          muteFxEngaged = next
          broadcastState()
        }
      }
    },
    onSysexBytes: (bytes) => {
      const cmd = parseMmcTransportCommand(bytes)
      if (cmd === 'play') {
        transportPlaying = true
        broadcastState()
      } else if (cmd === 'stop') {
        transportPlaying = false
        broadcastState()
      }
    },
    onNoteOn: (msg) => {
      const t = getState(store).transport
      if (t.mode !== 'note') return
      if (!ch0Matches(msg.channel, t.channel)) return
      if (msg.note === t.startNote) {
        transportPlaying = true
        broadcastState()
      } else if (msg.note === t.stopNote) {
        transportPlaying = false
        broadcastState()
      }
    },
    onSystemRealtimeStart: () => {
      transportPlaying = true
      broadcastState()
    },
    onSystemRealtimeStop: () => {
      transportPlaying = false
      broadcastState()
    }
  })
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 780,
    minWidth: 520,
    minHeight: 480,
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

  win.on('close', () => {
    if (displayWindow && !displayWindow.isDestroyed()) {
      displayWindow.destroy()
      displayWindow = null
    }
  })

  win.on('closed', () => {
    controlWindow = null
  })

  return win
}

function createDisplayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    fullscreen: false,
    backgroundColor: '#0a0a0c',
    autoHideMenuBar: true,
    title: `ViewerOne v${app.getVersion()} — Display`,
    webPreferences: {
      preload: preloadScriptPath(),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/, '')
    void win.loadURL(`${base}/display/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/display/index.html'))
  }

  win.on('closed', () => {
    displayWindow = null
  })

  return win
}

function placeDisplayOnSecondary(win: BrowserWindow): void {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const external = displays.find((d) => d.id !== primary.id) ?? primary
  const { x, y, width, height } = external.workArea
  win.setBounds({ x, y, width, height })
  win.setFullScreen(true)
}

function ensureDisplayWindow(): BrowserWindow {
  if (displayWindow && !displayWindow.isDestroyed()) return displayWindow
  displayWindow = createDisplayWindow()
  return displayWindow
}

function openDisplayWindowAction(): void {
  const win = ensureDisplayWindow()
  win.show()
  placeDisplayOnSecondary(win)
}

function hideDisplayWindowAction(): void {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.setFullScreen(false)
    displayWindow.hide()
  }
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
    if (patch.transport !== undefined) allowed.transport = sanitizeTransport(patch.transport)
    if (patch.muteAll !== undefined) allowed.muteAll = sanitizeCc(patch.muteAll)
    if (patch.muteFx !== undefined) allowed.muteFx = sanitizeCc(patch.muteFx)
    setState(store, allowed)
    if (
      allowed.midiInputName !== undefined ||
      allowed.midiOutputName !== undefined ||
      allowed.programChangeChannel !== undefined
    ) {
      applyMidiFromState()
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('midi:refresh', () => {
    applyMidiFromState()
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('window:display:open', () => {
    openDisplayWindowAction()
    return buildPublicState()
  })

  ipcMain.handle('window:display:hide', () => {
    hideDisplayWindowAction()
    return buildPublicState()
  })

  ipcMain.handle('action:start', () => {
    midi.sendTransportStart(getState(store).transport)
    transportPlaying = true
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('action:stop', () => {
    midi.sendTransportStop(getState(store).transport)
    transportPlaying = false
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('action:muteAll', () => {
    muteAllEngaged = !muteAllEngaged
    midi.sendCcToggle(getState(store).muteAll, muteAllEngaged)
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('action:muteFx', () => {
    muteFxEngaged = !muteFxEngaged
    midi.sendCcToggle(getState(store).muteFx, muteFxEngaged)
    broadcastState()
    return buildPublicState()
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

function sanitizeTransport(t: AppState['transport']): AppState['transport'] {
  const mode = t.mode === 'mmc' ? 'mmc' : 'note'
  return {
    mode,
    channel: clampInt(t.channel, 1, 16),
    startNote: clampInt(t.startNote, 0, 127),
    stopNote: clampInt(t.stopNote, 0, 127)
  }
}

function sanitizeCc(t: Partial<AppState['muteAll']> & Record<string, unknown>): AppState['muteAll'] {
  const cur = getState(store).muteAll
  const rawMode = t.outMode
  const outMode =
    rawMode === 'absolute' || rawMode === 'toggle127'
      ? rawMode
      : cur.outMode === 'absolute' || cur.outMode === 'toggle127'
        ? cur.outMode
        : 'absolute'
  return {
    channel: clampInt(Number(t.channel ?? cur.channel), 1, 16),
    cc: clampInt(Number(t.cc ?? cur.cc), 0, 127),
    valueOn: clampInt(Number(t.valueOn ?? cur.valueOn), 0, 127),
    valueOff: clampInt(Number(t.valueOff ?? cur.valueOff), 0, 127),
    outMode
  }
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
    setupAppMenu({
      openDisplay: () => openDisplayWindowAction(),
      hideDisplay: () => hideDisplayWindowAction()
    })
    controlWindow = createControlWindow()

    if (screen.getAllDisplays().length > 1) {
      openDisplayWindowAction()
    }

    screen.on('display-added', () => {
      if (screen.getAllDisplays().length > 1) {
        openDisplayWindowAction()
      }
    })

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
    if (displayWindow && !displayWindow.isDestroyed()) {
      displayWindow.destroy()
      displayWindow = null
    }
    midi.closeInput()
    midi.closeOutput()
  })
}
