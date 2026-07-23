import { installProcessGuards } from './processGuards.js'
import { app, BrowserWindow, ipcMain } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppStore, getState, setState, newSetlistItem, assignLedPatternsByOrder } from './store.js'
import { MidiService, listInputs, listOutputs } from './midi.js'
import {
  pushEsp32Payload,
  pushEsp32LedPattern,
  pushEsp32LedBrightness,
  setEsp32LineHandler,
  setEsp32SerialPort,
  shutdownEsp32Serial,
  type Esp32FromDeviceMsg
} from './esp32Bridge.js'
import { buildEsp32DisplayPayload } from '../shared/esp32Payload.js'
import {
  clampLedBrightness,
  clampLedPatternId,
  ledPatternName,
  songLedPatternForIndex
} from '../shared/ledPatterns.js'
import { ESP32_SERIAL_PORT_AUTO } from '../shared/esp32Serial.js'
import { ensureLoopMidiRunning } from './loopMidi.js'
import { detectCubasePorts, detectMixerPorts } from '../shared/midiAutoDetect.js'
import {
  CUBASE_PC_CHANNEL,
  CUBASE_MUTE_CHANNEL,
  CUBASE_MUTE_CC,
  MIXER_MUTE_CHANNEL,
  MIXER_MUTE_CC,
  MIXER_MUTE_INVERTED,
  MIDI_PC_SONG_MAX,
  MIDI_PC_LED_IDLE,
  MIDI_PC_LED_APPLY,
  LED_IDLE_DIM_BRIGHTNESS
} from '../shared/midiConfig.js'
import type { AppState, PublicState, SetlistItem } from '../shared/types.js'

// Must run before any MIDI/serial traffic — EPIPE on stdout used to kill the main process mid-gig.
installProcessGuards()

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

/** Set once we intentionally shut down — blocks MIDI auto-reconnect from resurrecting a headless process. */
let isQuitting = false

/** Debounced auto-reconnect when a MIDI send fails / port drops mid-gig. */
let midiReconnectTimer: ReturnType<typeof setTimeout> | null = null
let midiReconnectInFlight = false

function clearMidiReconnectTimer(): void {
  if (midiReconnectTimer) {
    clearTimeout(midiReconnectTimer)
    midiReconnectTimer = null
  }
}

function scheduleMidiReconnect(reason: string): void {
  if (isQuitting || midiReconnectInFlight) return
  clearMidiReconnectTimer()
  console.warn(`[ViewerOne] MIDI: scheduling reconnect — ${reason}`)
  midiReconnectTimer = setTimeout(() => {
    midiReconnectTimer = null
    if (isQuitting) return
    void (async () => {
      if (isQuitting || midiReconnectInFlight) return
      midiReconnectInFlight = true
      try {
        await refreshMidiConnection()
        broadcastUiState()
      } catch (err) {
        console.warn('[ViewerOne] MIDI: auto-reconnect failed —', err)
      } finally {
        midiReconnectInFlight = false
      }
    })()
  }, 400)
}

midi.setDisconnectHandler((which) => {
  if (which === 'cubaseOut') cubaseOutputOpen = false
  if (which === 'cubaseIn') cubaseInputOpen = false
  if (which === 'mixerOut') mixerOutputOpen = false
  if (which === 'mixerIn') mixerInputOpen = false
  if (isQuitting) return
  broadcastUiState()
  scheduleMidiReconnect(`${which} lost`)
})

/** Close control window → fully exit on Windows (no tray). Native MIDI/serial can otherwise keep Electron alive. */
function quitViewerOne(): void {
  if (isQuitting) {
    app.quit()
    return
  }
  isQuitting = true
  clearMidiReconnectTimer()
  shutdownEsp32Serial()
  try {
    midi.closeInput()
    midi.closeMixerInput()
    midi.closeMixerOutput()
    midi.closeOutput()
  } catch {
    /* ignore — quitting anyway */
  }
  app.quit()
  // Force-exit if easymidi/serialport keep the Node event loop alive after quit.
  setTimeout(() => {
    app.exit(0)
  }, 750).unref()
}

/** Ignore CC echo for a short window after we send mute CC (touch → out → Cubase/mixer → in). */
let muteCcSentAtMs = 0

/** Live MIDI connection status, surfaced in the UI since ports are auto-detected with no manual config. */
let cubaseInputName: string | null = null
let cubaseOutputName: string | null = null
let cubaseInputOpen = false
let cubaseOutputOpen = false
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
/** Last Cubase Program Change (UI 1–127) + channel, for the control-panel status line. */
let cubaseLastPc: number | null = null
let cubaseLastPcChannel: number | null = null
let cubaseLastPcAtMs: number | null = null

/** Mirrors ESP LED pattern for the desktop preview (synced via boot / led serial events / MIDI LED PCs). */
let ledPattern = 'knight_rider'

/** True while PC 126 idle dim is active — brightness slider is held until PC 127 / apply. */
let ledIdleDimActive = false

/** Last reserved LED PC (126/127) for UI flash — real MIDI or simulate buttons. */
let ledMidiPulse: 126 | 127 | null = null
let ledMidiPulseAt = 0

function buildPublicState(): PublicState {
  const base = getState(store)
  const queuedRow = base.currentSongId
    ? base.setlist.find((r) => r.id === base.currentSongId)
    : null
  return {
    ...base,
    appVersion: app.getVersion(),
    ledPattern,
    queuedLedPattern: queuedRow ? clampLedPatternId(queuedRow.ledPattern) : null,
    ledMidiPulse,
    ledMidiPulseAt,
    midi: {
      cubaseInputName,
      cubaseInputOpen,
      cubaseOutputName,
      cubaseOutputOpen,
      mixerInputName,
      mixerInputOpen,
      mixerOutputName,
      mixerOutputOpen,
      mixerLastMessageAgoMs: mixerLastMessageAtMs !== null ? Date.now() - mixerLastMessageAtMs : null,
      mixerLastCc,
      mixerLastSentAgoMs: mixerLastSentAtMs !== null ? Date.now() - mixerLastSentAtMs : null,
      mixerLastSentCc,
      cubaseLastSentAgoMs: cubaseLastSentAtMs !== null ? Date.now() - cubaseLastSentAtMs : null,
      cubaseLastSentCc,
      cubaseLastPc,
      cubaseLastPcChannel,
      cubaseLastPcAgoMs: cubaseLastPcAtMs !== null ? Date.now() - cubaseLastPcAtMs : null
    }
  }
}

function noteLedMidiPulse(pc: 126 | 127): void {
  ledMidiPulse = pc
  ledMidiPulseAt = Date.now()
}

/** Song title/year/mute JSON only — does not change LEDs. */
function broadcastEsp32DisplayIfEnabled(): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  pushEsp32Payload(buildEsp32DisplayPayload(st))
}

/** Push settings brightness unless between-song idle dim is active. */
function pushEsp32BrightnessFromSettings(): void {
  const st = getState(store)
  if (!st.esp32Enabled || ledIdleDimActive) return
  pushEsp32LedBrightness(st.ledBrightness)
}

/**
 * Dim slow knight rider (idle lights). Same path as MIDI PC 126 / UI simulate.
 * Display text is left as-is.
 */
function applyLedIdle(): void {
  noteLedMidiPulse(MIDI_PC_LED_IDLE)
  ledIdleDimActive = true
  ledPattern = 'knight_rider'
  const st = getState(store)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(0)
    pushEsp32LedBrightness(LED_IDLE_DIM_BRIGHTNESS)
  }
  broadcastUiState()
}

/**
 * Apply LEDs for the currently displayed song. Same path as MIDI PC 127 / UI simulate.
 * Restores normal brightness. No current song → knight_rider (id 0) at settings brightness.
 */
function applyLedForCurrentSong(): void {
  noteLedMidiPulse(MIDI_PC_LED_APPLY)
  const st = getState(store)
  ledIdleDimActive = false
  const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
  const id = row ? clampLedPatternId(row.ledPattern) : 0
  ledPattern = ledPatternName(id)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(id)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  broadcastUiState()
}

/**
 * Live LED pattern test (control UI). Same push path as PC 127, but any id 0–20 —
 * does not change the song’s stored ledPattern. Clears idle dim and restores brightness.
 */
function previewLedPattern(rawId: unknown): void {
  const id = clampLedPatternId(rawId)
  const st = getState(store)
  ledIdleDimActive = false
  ledPattern = ledPatternName(id)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(id)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  broadcastUiState()
}

/** Push current song/mute JSON only — board keeps its own LED state until PC 126/127. */
function onEsp32SerialOpened(): void {
  broadcastEsp32DisplayIfEnabled()
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
  const changed = st.fxMuted !== muted
  if (changed) {
    setState(store, { fxMuted: muted })
  }
  if (opts.sendToCubase) sendMuteCcToCubase(muted)
  if (opts.sendToMixer) sendMuteCcToMixer(muted)
  if (changed) {
    // Mute updates display tint + CC only — LEDs stay on PC 126/127 (and pattern preview).
    broadcastState()
  }
}

function toggleFxMutedFromEsp(): void {
  const st = getState(store)
  applyFxMuted(!st.fxMuted, { sendToCubase: true, sendToMixer: true })
}

function applyLedPatternFromEsp(name: unknown): void {
  if (typeof name !== 'string' || !name.trim()) return
  const next = name.trim()
  if (next === ledPattern) return
  ledPattern = next
  broadcastState()
}

function handleEsp32Line(msg: Esp32FromDeviceMsg): void {
  const evt = msg['evt']
  if (evt === 'mute_toggle') toggleFxMutedFromEsp()
  if (evt === 'boot') {
    applyLedPatternFromEsp(msg['led'])
    // Board reset — resend display JSON only; strip keeps firmware boot KR until PC 126/127.
    console.log('[ViewerOne] ESP32 reported boot/reset — resending display state')
    broadcastEsp32DisplayIfEnabled()
  }
  if (evt === 'led' && msg['ok'] === true) {
    applyLedPatternFromEsp(msg['name'])
  }
}

function syncEsp32SerialFromStore(): void {
  const st = getState(store)
  if (st.esp32Enabled) {
    setEsp32SerialPort(ESP32_SERIAL_PORT_AUTO, () => onEsp32SerialOpened())
  } else {
    setEsp32SerialPort(null)
  }
}

function broadcastUiState(): void {
  const payload = buildPublicState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('state:update', payload)
  }
}

function broadcastState(): void {
  broadcastUiState()
  broadcastEsp32DisplayIfEnabled()
}

/**
 * Connects to Cubase (one-way in: song changes + its own auto-mute automation, over a loopMIDI
 * cable pair; one-way out: ViewerOne's own mute changes, so Cubase's state/automation stays in
 * sync) and to the mixer (two-way, directly over its own USB MIDI port, independent of Cubase).
 * Everything is auto-detected by name — see shared/midiAutoDetect.ts — and the channel/CC
 * conventions are fixed in shared/midiConfig.ts.
 *
 * Always closes existing handles first so a Reconnect refreshes the OS device list cleanly.
 */
function connectMidi(): void {
  const inputs = listInputs()
  const outputs = listOutputs()
  const cubaseMuteCh0 = CUBASE_MUTE_CHANNEL - 1
  const mixerMuteCh0 = MIXER_MUTE_CHANNEL - 1

  console.log(
    `[ViewerOne] MIDI: scanning ports — inputs=[${inputs.join(' | ') || 'none'}] outputs=[${outputs.join(' | ') || 'none'}]`
  )

  const cubase = detectCubasePorts(inputs, outputs)
  cubaseInputName = cubase.input
  cubaseOutputName = cubase.output
  cubaseLastSentAtMs = null
  cubaseLastSentCc = null
  cubaseLastPc = null
  cubaseLastPcChannel = null
  cubaseLastPcAtMs = null
  midi.setProgramChangeChannel(CUBASE_PC_CHANNEL)
  cubaseInputOpen = midi.openInput(cubase.input, {
    onProgramChange: (wireProgram, channel0) => {
      // Surface every incoming PC in the UI (any channel) so a dead Cubase link is obvious.
      cubaseLastPc = wireProgram + 1
      cubaseLastPcChannel = channel0 + 1
      cubaseLastPcAtMs = Date.now()
      broadcastUiState()

      // Cubase/UI PC = wire + 1 (see shared/midiConfig.ts). Match reserved LED PCs by exact wire.
      if (wireProgram === MIDI_PC_LED_IDLE - 1) {
        console.log(`[ViewerOne] MIDI: PC ${MIDI_PC_LED_IDLE} (LED idle) ch ${channel0 + 1}`)
        applyLedIdle()
        return
      }
      if (wireProgram === MIDI_PC_LED_APPLY - 1) {
        console.log(`[ViewerOne] MIDI: PC ${MIDI_PC_LED_APPLY} (LED apply) ch ${channel0 + 1}`)
        applyLedForCurrentSong()
        return
      }
      const pc = wireProgram + 1
      if (pc < 1 || pc > MIDI_PC_SONG_MAX) {
        console.log(`[ViewerOne] MIDI: ignoring out-of-range PC wire=${wireProgram} (UI ${pc}) ch ${channel0 + 1}`)
        return
      }
      const s = getState(store)
      const row = s.setlist.find((r) => r.program === pc)
      if (row) {
        // Display + queue only — LEDs change via PC 126/127.
        console.log(`[ViewerOne] MIDI: song PC ${pc} → "${row.title}" (ch ${channel0 + 1})`)
        setState(store, { currentSongId: row.id })
        broadcastState()
      } else {
        console.log(`[ViewerOne] MIDI: song PC ${pc} — no setlist row (ch ${channel0 + 1})`)
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
  cubaseOutputOpen = midi.openOutput(cubase.output)

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

  console.log(
    `[ViewerOne] MIDI: connected — Cubase in=${cubaseInputName ?? '—'}(${cubaseInputOpen ? 'open' : 'closed'}) ` +
      `out=${cubaseOutputName ?? '—'}(${cubaseOutputOpen ? 'open' : 'closed'}); ` +
      `Mixer in=${mixerInputName ?? '—'}(${mixerInputOpen ? 'open' : 'closed'}) ` +
      `out=${mixerOutputName ?? '—'}(${mixerOutputOpen ? 'open' : 'closed'})`
  )
}

function disconnectMidi(): void {
  midi.closeInput()
  midi.closeMixerInput()
  midi.closeMixerOutput()
  midi.closeOutput()
  cubaseInputOpen = false
  cubaseOutputOpen = false
  mixerInputOpen = false
  mixerOutputOpen = false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reconnect path for the UI button: ensure loopMIDI is running, fully close handles, settle
 * (Windows/easymidi often needs a beat after close), then re-detect and open with retries.
 */
async function refreshMidiConnection(): Promise<void> {
  console.log('[ViewerOne] MIDI: refresh requested')
  ensureLoopMidiRunning()
  disconnectMidi()
  // Clear detected names so the UI doesn't briefly show stale "connected" while reopening.
  cubaseInputName = null
  cubaseOutputName = null
  mixerInputName = null
  mixerOutputName = null
  await sleep(220)
  for (let attempt = 0; attempt < 4; attempt++) {
    connectMidi()
    const cubaseOk = cubaseInputOpen || cubaseOutputOpen
    const mixerOk = mixerInputOpen || mixerOutputOpen
    if (cubaseOk || mixerOk) return
    if (attempt < 3) {
      console.log(`[ViewerOne] MIDI: refresh retry ${attempt + 1}/3 — no ports open yet`)
      disconnectMidi()
      cubaseInputName = null
      cubaseOutputName = null
      mixerInputName = null
      mixerOutputName = null
      await sleep(280 + attempt * 120)
    }
  }
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
    // X / Alt+F4 on the only window must end the app on Windows (no tray / background mode).
    if (process.platform !== 'darwin') {
      quitViewerOne()
    }
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
      year: String(
        row.year ?? (row as SetlistItem & { chords?: string }).chords ?? ''
      ),
      ledPattern: clampLedPatternId(row.ledPattern)
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
    const next = assignProgramsByOrder([
      ...st.setlist,
      newSetlistItem({ ledPattern: songLedPatternForIndex(st.setlist.length) })
    ])
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
    const st = getState(store)
    const allowed: Partial<AppState> = {}
    // fxMuted goes through applyFxMuted for CC out + display tint (not LEDs).
    const mutedToApply = patch.fxMuted !== undefined ? Boolean(patch.fxMuted) : undefined
    if (patch.esp32Enabled !== undefined) allowed.esp32Enabled = Boolean(patch.esp32Enabled)

    let nextExternal =
      patch.ledExternalPower !== undefined ? Boolean(patch.ledExternalPower) : st.ledExternalPower
    if (patch.ledExternalPower !== undefined) allowed.ledExternalPower = nextExternal

    if (patch.ledBrightness !== undefined || patch.ledExternalPower !== undefined) {
      const rawBri =
        patch.ledBrightness !== undefined ? patch.ledBrightness : st.ledBrightness
      allowed.ledBrightness = clampLedBrightness(rawBri, nextExternal)
    }

    setState(store, allowed)
    if (mutedToApply !== undefined) {
      applyFxMuted(mutedToApply, { sendToCubase: true, sendToMixer: true })
    }
    if (allowed.esp32Enabled !== undefined) {
      syncEsp32SerialFromStore()
    }
    if (allowed.ledBrightness !== undefined || allowed.ledExternalPower !== undefined) {
      pushEsp32BrightnessFromSettings()
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('midi:refresh', async () => {
    try {
      await refreshMidiConnection()
    } catch (err) {
      console.warn('[ViewerOne] MIDI: refresh failed —', err)
      disconnectMidi()
      cubaseInputName = null
      cubaseOutputName = null
      mixerInputName = null
      mixerOutputName = null
    }
    broadcastState()
    return buildPublicState()
  })

  /** Simulate Cubase PC 126 (LED idle) — same path as real MIDI. */
  ipcMain.handle('led:midiIdle', () => {
    applyLedIdle()
    return buildPublicState()
  })

  /** Simulate Cubase PC 127 (LED apply) — same path as real MIDI. */
  ipcMain.handle('led:midiApply', () => {
    applyLedForCurrentSong()
    return buildPublicState()
  })

  /** Live-test any LED pattern on the ESP (does not change the song’s stored pattern). */
  ipcMain.handle('led:previewPattern', (_e, id: unknown) => {
    previewLedPattern(id)
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

/** Program numbers follow setlist order: row i → PC = min(i + 1, MIDI_PC_SONG_MAX). PC 126/127 reserved for LED. */
function assignProgramsByOrder(items: SetlistItem[]): SetlistItem[] {
  return items.map((row, i) => ({
    ...row,
    program: Math.min(MIDI_PC_SONG_MAX, i + 1)
  }))
}

function programsMatchListOrder(items: SetlistItem[]): boolean {
  return items.every((row, i) => row.program === Math.min(MIDI_PC_SONG_MAX, i + 1))
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
    // Programs by order; every song defaults to random (20).
    setState(store, {
      setlist: assignLedPatternsByOrder(
        programsMatchListOrder(initial.setlist)
          ? initial.setlist
          : assignProgramsByOrder(initial.setlist)
      )
    })
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
      quitViewerOne()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    clearMidiReconnectTimer()
    shutdownEsp32Serial()
    midi.closeInput()
    midi.closeMixerInput()
    midi.closeMixerOutput()
    midi.closeOutput()
  })
}
