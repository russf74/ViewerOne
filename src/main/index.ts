import { app, BrowserWindow, ipcMain } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppStore, getState, setState, newSetlistItem } from './store.js'
import { MidiService, listInputs, listOutputs } from './midi.js'
import {
  pushEsp32Payload,
  setEsp32LineHandler,
  setEsp32SerialPort,
  shutdownEsp32Serial,
  type Esp32FromDeviceMsg
} from './esp32Bridge.js'
import { buildEsp32DisplayPayload } from '../shared/esp32Payload.js'
import { ESP32_SERIAL_PORT_AUTO } from '../shared/esp32Serial.js'
import { ensureLoopMidiRunning } from './loopMidi.js'
import { detectCubasePorts, detectMixerPorts } from '../shared/midiAutoDetect.js'
import {
  CUBASE_PC_CHANNEL,
  CUBASE_MUTE_CHANNEL,
  CUBASE_MUTE_CC,
  MIXER_MUTE_CHANNEL,
  MIXER_MUTE_CC,
  MIXER_MUTE_INVERTED
} from '../shared/midiConfig.js'
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

/** Ignore CC echo for a short window after we send mute CC (touch → out → Cubase/mixer → in). */
let muteCcSentAtMs = 0

/** Live MIDI connection status, surfaced in the UI since ports are auto-detected with no manual config. */
let cubaseInputName: string | null = null
let cubaseOutputName: string | null = null
let mixerInputName: string | null = null
let mixerInputOpen = false
let mixerOutputName: string | null = null
let mixerOutputOpen = false
let mixerLastMessageAtMs: number | null = null
let mixerLastCc: { channel: number; controller: number; value: number } | null = null
let mixerLastSentAtMs: number | null = null
let mixerLastSentCc: { channel: number; controller: number; value: number } | null = null
let cubaseLastSentAtMs: number | null = null
let cubaseLastSentCc: { channel: number; controller: number; value: number } | null = null

function buildPublicState(): PublicState {
  const base = getState(store)
  return {
    ...base,
    appVersion: app.getVersion(),
    midi: {
      cubaseInputName,
      cubaseOutputName,
      mixerInputName,
      mixerInputOpen,
      mixerOutputName,
      mixerOutputOpen,
      mixerLastMessageAgoMs: mixerLastMessageAtMs !== null ? Date.now() - mixerLastMessageAtMs : null,
      mixerLastCc,
      mixerLastSentAgoMs: mixerLastSentAtMs !== null ? Date.now() - mixerLastSentAtMs : null,
      mixerLastSentCc,
      cubaseLastSentAgoMs: cubaseLastSentAtMs !== null ? Date.now() - cubaseLastSentAtMs : null,
      cubaseLastSentCc
    }
  }
}

function broadcastEsp32IfEnabled(): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  pushEsp32Payload(buildEsp32DisplayPayload(st))
}

function ccValueToFxMuted(value: number, inverted = false): boolean {
  return inverted ? value >= 64 : value < 64
}

/**
 * Sends mute state to Cubase (its own private ch1/CC85 convention — Cubase relays this onward
 * via its own "X32 Mutes" track for its own automation-driven use cases). This is also how song
 * changes reach Cubase, so it's a single well-tested path for everything ViewerOne sends there.
 */
function sendMuteCcToCubase(muted: boolean): void {
  muteCcSentAtMs = Date.now()
  const value = muted ? 0 : 127
  cubaseLastSentAtMs = Date.now()
  cubaseLastSentCc = { channel: CUBASE_MUTE_CHANNEL - 1, controller: CUBASE_MUTE_CC, value }
  console.log(`[ViewerOne] MIDI: sending mute=${muted} to Cubase (ch ${CUBASE_MUTE_CHANNEL}, CC ${CUBASE_MUTE_CC}, val ${value}) on "${cubaseOutputName ?? '(no output port)'}"`)
  midi.sendControlChange(CUBASE_MUTE_CHANNEL, CUBASE_MUTE_CC, value)
}

/**
 * Sends mute state directly to the mixer's own USB MIDI port, using its native ch2/CC63
 * convention (inverted: 127 = muted). Independent of Cubase, so this keeps working even with
 * Cubase closed. If ViewerOne couldn't open the mixer output (e.g. Cubase already has it open
 * for its own relay), this is a silent no-op — see midi.ts openMixerOutput.
 */
function sendMuteCcToMixer(muted: boolean): void {
  muteCcSentAtMs = Date.now()
  const value = MIXER_MUTE_INVERTED ? (muted ? 127 : 0) : muted ? 0 : 127
  mixerLastSentAtMs = Date.now()
  mixerLastSentCc = { channel: MIXER_MUTE_CHANNEL - 1, controller: MIXER_MUTE_CC, value }
  console.log(`[ViewerOne] MIDI: sending mute=${muted} to mixer (ch ${MIXER_MUTE_CHANNEL}, CC ${MIXER_MUTE_CC}, val ${value}) on "${mixerOutputName ?? '(no output port)'}"`)
  midi.sendMixerControlChange(MIXER_MUTE_CHANNEL, MIXER_MUTE_CC, value)
}

function applyFxMuted(muted: boolean, opts: { sendToCubase: boolean; sendToMixer: boolean }): void {
  const st = getState(store)
  if (st.fxMuted !== muted) {
    setState(store, { fxMuted: muted })
    broadcastState()
  }
  if (opts.sendToCubase) sendMuteCcToCubase(muted)
  if (opts.sendToMixer) sendMuteCcToMixer(muted)
}

function toggleFxMutedFromEsp(): void {
  const st = getState(store)
  applyFxMuted(!st.fxMuted, { sendToCubase: true, sendToMixer: true })
}

function handleEsp32Line(msg: Esp32FromDeviceMsg): void {
  const evt = msg['evt']
  if (evt === 'mute_toggle') toggleFxMutedFromEsp()
  if (evt === 'boot') {
    // Board reset (manual power cycle or its own watchdog auto-recovery) — resync its display.
    console.log('[ViewerOne] ESP32 reported boot/reset — resending current song/mute state')
    broadcastEsp32IfEnabled()
  }
}

function syncEsp32SerialFromStore(): void {
  const st = getState(store)
  if (st.esp32Enabled) {
    setEsp32SerialPort(ESP32_SERIAL_PORT_AUTO, () => broadcastEsp32IfEnabled())
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

/**
 * Connects to Cubase (one-way in: song changes + its own auto-mute automation, over a loopMIDI
 * cable pair; one-way out: ViewerOne's own mute changes, so Cubase's state/automation stays in
 * sync) and to the mixer (two-way, directly over its own USB MIDI port, independent of Cubase).
 * Everything is auto-detected by name — see shared/midiAutoDetect.ts — and the channel/CC
 * conventions are fixed in shared/midiConfig.ts.
 */
function connectMidi(): void {
  const inputs = listInputs()
  const outputs = listOutputs()
  const cubaseMuteCh0 = CUBASE_MUTE_CHANNEL - 1
  const mixerMuteCh0 = MIXER_MUTE_CHANNEL - 1

  const cubase = detectCubasePorts(inputs, outputs)
  cubaseInputName = cubase.input
  cubaseOutputName = cubase.output
  cubaseLastSentAtMs = null
  cubaseLastSentCc = null
  midi.setProgramChangeChannel(CUBASE_PC_CHANNEL)
  midi.openInput(cubase.input, {
    onProgramChange: (wireProgram) => {
      const s = getState(store)
      const pc = Math.min(127, wireProgram + 1)
      const row = s.setlist.find((r) => r.program === pc)
      if (row) {
        setState(store, { currentSongId: row.id })
        broadcastState()
      }
    },
    onControlChange: (msg) => {
      if (msg.channel !== cubaseMuteCh0 || msg.controller !== CUBASE_MUTE_CC) return
      if (Date.now() - muteCcSentAtMs < 90) return
      const muted = ccValueToFxMuted(msg.value)
      // Cubase already owns telling the mixer for its own automation, so nothing echoed back out.
      applyFxMuted(muted, { sendToCubase: false, sendToMixer: false })
    }
  })
  midi.openOutput(cubase.output)

  // Direct, two-way connection to the mixer's own USB MIDI port — independent of Cubase, so
  // mute stays in sync (both ways) even with Cubase closed or its own routing unavailable.
  const mixer = detectMixerPorts(inputs, outputs)
  mixerInputName = mixer.input
  mixerOutputName = mixer.output
  mixerLastMessageAtMs = null
  mixerLastCc = null
  mixerLastSentAtMs = null
  mixerLastSentCc = null
  mixerInputOpen = midi.openMixerInput(mixer.input, (msg) => {
    mixerLastMessageAtMs = Date.now()
    mixerLastCc = msg
    broadcastState()
    if (msg.channel !== mixerMuteCh0 || msg.controller !== MIXER_MUTE_CC) return
    if (Date.now() - muteCcSentAtMs < 90) return
    const muted = ccValueToFxMuted(msg.value, MIXER_MUTE_INVERTED)
    // Tell Cubase so its own state stays in sync; don't echo straight back out to the mixer.
    applyFxMuted(muted, { sendToCubase: true, sendToMixer: false })
  })
  mixerOutputOpen = midi.openMixerOutput(mixer.output)
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

  // The renderer's static <title> tag would otherwise overwrite this once the page loads —
  // keep the version-bearing title above as the single source of truth for the window/taskbar.
  win.on('page-title-updated', (e) => e.preventDefault())

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
    if (patch.fxMuted !== undefined) allowed.fxMuted = Boolean(patch.fxMuted)
    if (patch.esp32Enabled !== undefined) allowed.esp32Enabled = Boolean(patch.esp32Enabled)
    setState(store, allowed)
    if (allowed.fxMuted !== undefined) {
      const muted = getState(store).fxMuted
      sendMuteCcToCubase(muted)
      sendMuteCcToMixer(muted)
    }
    if (allowed.esp32Enabled !== undefined) {
      syncEsp32SerialFromStore()
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('midi:refresh', () => {
    connectMidi()
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
    midi.sendProgramChange(CUBASE_PC_CHANNEL, row.program)
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
    midi.sendProgramChange(CUBASE_PC_CHANNEL, row.program)
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
    setEsp32LineHandler(handleEsp32Line)
    registerIpc()
    const initial = getState(store)
    if (!programsMatchListOrder(initial.setlist)) {
      setState(store, { setlist: assignProgramsByOrder(initial.setlist) })
    }
    connectMidi()
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
      midi.closeMixerInput()
      midi.closeMixerOutput()
      midi.closeOutput()
      app.quit()
    }
  })

  app.on('before-quit', () => {
    shutdownEsp32Serial()
    midi.closeInput()
    midi.closeMixerInput()
    midi.closeMixerOutput()
    midi.closeOutput()
  })
}
