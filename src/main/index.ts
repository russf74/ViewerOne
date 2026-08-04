import { installProcessGuards } from './processGuards.js'
import { app, BrowserWindow, ipcMain } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppStore, getState, setState, newSetlistItem } from './store.js'
import { MidiService, listInputs, listOutputs, parseMmcTransportCommand } from './midi.js'
import {
  pushEsp32Payload,
  pushEsp32HelloRequest,
  pushEsp32LedPattern,
  pushEsp32LedBrightness,
  pushEsp32Prompt,
  setEsp32ConnectionHandler,
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
import { parseEsp32DisplayIdentity } from '../shared/esp32Device.js'
import { ensureLoopMidiRunning } from './loopMidi.js'
import { detectCubasePorts, detectMixerPorts } from '../shared/midiAutoDetect.js'
import {
  CUBASE_PC_CHANNEL,
  CUBASE_TRANSPORT_CHANNEL,
  CUBASE_TRANSPORT_START_NOTE,
  CUBASE_TRANSPORT_STOP_NOTE,
  CUBASE_MUTE_CHANNEL,
  CUBASE_MUTE_CC,
  MIXER_MUTE_CHANNEL,
  MIXER_MUTE_CC,
  MIXER_MUTE_INVERTED,
  MIDI_PC_SONG_MAX,
  MIDI_PC_PROMPT_1_ON,
  MIDI_PC_PROMPT_1_OFF,
  MIDI_PC_PROMPT_2_ON,
  MIDI_PC_PROMPT_2_OFF,
  MIDI_PC_LED_BLACKOUT,
  MIDI_PC_LED_IDLE,
  MIDI_PC_LED_APPLY,
  LED_IDLE_DIM_BRIGHTNESS
} from '../shared/midiConfig.js'
import type {
  AppState,
  ArrangerScanState,
  Esp32DisplayStatus,
  PublicState,
  SetlistItem
} from '../shared/types.js'
import {
  formatSetlistSeconds,
  normalizeSongLength,
  songLengthSeconds
} from '../shared/setlistTiming.js'

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
  stopCountdownTicker()
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

/** Ephemeral transport countdown. Song length in the persisted setlist is always authoritative. */
let countdownSongId: string | null = null
let countdownTotalSeconds = 0
let countdownRemainingMs = 0
let countdownRunning = false
let countdownStartedAtMs: number | null = null
let countdownLastPublishedSecond: number | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null
let lastTransportEvent: { action: 'start' | 'stop'; source: string; at: number } | null = null

/** Mirrors ESP LED pattern for the desktop preview (synced via boot / led serial events / MIDI LED PCs). */
let ledPattern = 'knight_rider'

/** Ephemeral hardware identity. The renderer simulates CrowPanel unless hardware identifies as CYD. */
let esp32Display: Esp32DisplayStatus = {
  connection: 'disabled',
  device: 'unknown',
  model: null,
  width: null,
  height: null
}

/** True while PC 126 idle dim is active — brightness slider is held until PC 127 / apply. */
let ledIdleDimActive = false

/** Last reserved LED PC (125/126/127) for UI flash — real MIDI or simulate buttons. */
let ledMidiPulse: 125 | 126 | 127 | null = null
let ledMidiPulseAt = 0

/** Absolute prompt-light state; retained across serial reconnects for deterministic resync. */
let prompt1On = false
let prompt2On = false
let promptMidiPulse: 120 | 121 | 122 | 123 | null = null
let promptMidiPulseAt = 0

const ARRANGER_CHANGE_TIMEOUT_MS = 1800
const ARRANGER_NO_CHANGE_ATTEMPTS = 3
const ARRANGER_SETTLE_MS = 150
const ARRANGER_REWIND_PULSES = 100
const ARRANGER_REWIND_PULSE_INTERVAL_MS = 20
const ARRANGER_REWIND_NOTE_DURATION_MS = 8
const ARRANGER_REWIND_SETTLE_MS = 400
let latestSongProgram: number | null = null
let songIdentityRevision = 0
let arrangerScanCancelled = false
let arrangerScan: ArrangerScanState = {
  active: false,
  phase: 'idle',
  collected: 0,
  message: 'Ready'
}

function countdownRemainingNowMs(now = Date.now()): number {
  if (!countdownRunning || countdownStartedAtMs === null) return countdownRemainingMs
  return Math.max(0, countdownRemainingMs - (now - countdownStartedAtMs))
}

function countdownSnapshot(): PublicState['countdown'] {
  const st = getState(store)
  const row = st.currentSongId ? st.setlist.find((item) => item.id === st.currentSongId) : null
  const rowTotal = row ? songLengthSeconds(row.length) : 0
  const ownsCurrentSong = Boolean(row && countdownSongId === row.id)
  const totalSeconds = ownsCurrentSong ? countdownTotalSeconds : rowTotal
  const remainingSeconds =
    totalSeconds > 0
      ? ownsCurrentSong
        ? Math.max(0, Math.ceil(countdownRemainingNowMs() / 1000))
        : totalSeconds
      : null
  return {
    running: countdownRunning && ownsCurrentSong,
    display: remainingSeconds === null ? '' : formatSetlistSeconds(remainingSeconds),
    remainingSeconds,
    totalSeconds: totalSeconds > 0 ? totalSeconds : null
  }
}

function resetCountdownForSong(songId: string | null, keepRunning = false): void {
  const st = getState(store)
  const row = songId ? st.setlist.find((item) => item.id === songId) : null
  countdownSongId = row?.id ?? null
  countdownTotalSeconds = row ? songLengthSeconds(row.length) : 0
  countdownRemainingMs = countdownTotalSeconds * 1000
  countdownRunning = keepRunning && countdownSongId !== null
  countdownStartedAtMs = countdownRunning ? Date.now() : null
  countdownLastPublishedSecond = countdownTotalSeconds > 0 ? countdownTotalSeconds : null
}

/**
 * Cubase may emit both a mapped note and MIDI realtime/MMC for one button press. Collapse those
 * near-simultaneous cross-protocol duplicates while preserving a deliberate second Start.
 */
function isDuplicateTransportEvent(action: 'start' | 'stop', source: string, now: number): boolean {
  const previous = lastTransportEvent
  lastTransportEvent = { action, source, at: now }
  return Boolean(
    previous &&
      previous.action === action &&
      previous.source !== source &&
      now - previous.at < 100
  )
}

function handleTransportStart(source: string): void {
  const now = Date.now()
  if (isDuplicateTransportEvent('start', source, now)) return
  const st = getState(store)
  if (countdownSongId !== st.currentSongId) resetCountdownForSong(st.currentSongId)
  if (countdownRunning || countdownRemainingMs <= 0) {
    resetCountdownForSong(st.currentSongId)
  } else {
    countdownRemainingMs = countdownRemainingNowMs(now)
  }
  countdownRunning = st.currentSongId !== null
  countdownStartedAtMs = countdownRunning ? now : null
  console.log(`[ViewerOne] MIDI: transport Start (${source}) — ${countdownSnapshot().display || 'length unknown'}`)
  broadcastState()
}

function handleTransportStop(source: string): void {
  const now = Date.now()
  if (isDuplicateTransportEvent('stop', source, now)) return
  countdownRemainingMs = countdownRemainingNowMs(now)
  countdownRunning = false
  countdownStartedAtMs = null
  console.log(`[ViewerOne] MIDI: transport Stop/Pause (${source}) — froze ${countdownSnapshot().display || 'unknown'}`)
  broadcastState()
}

function startCountdownTicker(): void {
  if (countdownTimer) return
  countdownTimer = setInterval(() => {
    if (!countdownRunning) return
    const snap = countdownSnapshot()
    if (snap.remainingSeconds === countdownLastPublishedSecond) return
    countdownLastPublishedSecond = snap.remainingSeconds
    if (snap.remainingSeconds === 0) {
      countdownRemainingMs = 0
      countdownRunning = false
      countdownStartedAtMs = null
    }
    // One UI + serial update per displayed second; never publish the 250ms ticker itself.
    broadcastState()
  }, 250)
  countdownTimer.unref()
}

function stopCountdownTicker(): void {
  if (!countdownTimer) return
  clearInterval(countdownTimer)
  countdownTimer = null
}

function buildPublicState(): PublicState {
  const base = getState(store)
  const queuedRow = base.currentSongId
    ? base.setlist.find((r) => r.id === base.currentSongId)
    : null
  return {
    ...base,
    appVersion: app.getVersion(),
    ledPattern,
    esp32Display,
    queuedLedPattern: queuedRow ? clampLedPatternId(queuedRow.ledPattern) : null,
    ledMidiPulse,
    ledMidiPulseAt,
    prompt1On,
    prompt2On,
    promptMidiPulse,
    promptMidiPulseAt,
    arrangerScan,
    countdown: countdownSnapshot(),
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

function noteLedMidiPulse(pc: 125 | 126 | 127): void {
  ledMidiPulse = pc
  ledMidiPulseAt = Date.now()
}

function applyPromptPc(pc: 120 | 121 | 122 | 123): void {
  const prompt: 1 | 2 = pc === MIDI_PC_PROMPT_1_ON || pc === MIDI_PC_PROMPT_1_OFF ? 1 : 2
  const on = pc === MIDI_PC_PROMPT_1_ON || pc === MIDI_PC_PROMPT_2_ON
  if (prompt === 1) prompt1On = on
  else prompt2On = on
  promptMidiPulse = pc
  promptMidiPulseAt = Date.now()
  if (getState(store).esp32Enabled) pushEsp32Prompt(prompt, on)
  broadcastUiState()
}

/** Song title/year/duration/mute JSON only — does not change LEDs. */
function broadcastEsp32DisplayIfEnabled(): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  pushEsp32Payload(buildEsp32DisplayPayload(st, countdownSnapshot().display))
}

/** Push settings brightness unless between-song idle dim is active. */
function pushEsp32BrightnessFromSettings(): void {
  const st = getState(store)
  if (!st.esp32Enabled || ledIdleDimActive) return
  pushEsp32LedBrightness(st.ledBrightness)
}

/**
 * Full LED blackout (pattern id 99). Same path as MIDI PC 125 / UI simulate / preview.
 * Clears idle dim and restores settings brightness (strip stays off via blackout pattern).
 */
function applyLedBlackout(): void {
  noteLedMidiPulse(MIDI_PC_LED_BLACKOUT)
  const st = getState(store)
  ledIdleDimActive = false
  ledPattern = ledPatternName(99)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(99)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  broadcastUiState()
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
 * Live LED pattern test (control UI). Same push path as PC 127, but any id 0–20 or 99 —
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

/** Push current song/mute JSON only — board keeps its own LED state until PC 125/126/127. */
function onEsp32SerialOpened(): void {
  pushEsp32HelloRequest()
  broadcastEsp32DisplayIfEnabled()
  const st = getState(store)
  if (st.esp32Enabled) {
    pushEsp32Prompt(1, prompt1On)
    pushEsp32Prompt(2, prompt2On)
  }
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
    // Mute updates display tint + CC only — LEDs stay on PC 125/126/127 (and pattern preview).
    broadcastState()
  }
}

function toggleFxMutedFromEsp(): void {
  const st = getState(store)
  applyFxMuted(!st.fxMuted, { sendToCubase: true, sendToMixer: true })
}

/** Group1 / ALL is a separate CrowPanel state and must never enter the Group6 / FX CC path. */
function toggleAllMutedFromEsp(): void {
  const st = getState(store)
  setState(store, { allMuted: !st.allMuted })
  broadcastState()
}

function applyLedPatternFromEsp(name: unknown): void {
  if (typeof name !== 'string' || !name.trim()) return
  const next = name.trim()
  if (next === ledPattern) return
  ledPattern = next
  broadcastState()
}

function handleEsp32Line(msg: Esp32FromDeviceMsg): void {
  const identity = parseEsp32DisplayIdentity(msg)
  if (identity) {
    esp32Display = identity
    console.log(
      `[ViewerOne] ESP32 identity: ${identity.device} ${identity.model ?? ''} ${identity.width ?? '?'}x${identity.height ?? '?'}`
    )
    broadcastUiState()
  }

  const evt = msg['evt']
  if (evt === 'mute_toggle') {
    // CrowPanel groups are independent: ALL = Group1 state; FX/legacy bare = Group6 CC path.
    const group = typeof msg['group'] === 'string' ? msg['group'].toLowerCase() : ''
    if (!group || group === 'fx') {
      toggleFxMutedFromEsp()
    } else if (group === 'all') {
      toggleAllMutedFromEsp()
    } else {
      console.log(`[ViewerOne] ESP32 mute_toggle ignored for group=${group}`)
    }
  }
  if (evt === 'boot') {
    applyLedPatternFromEsp(msg['led'])
    // Board reset — resend display JSON only; strip keeps firmware boot KR until PC 125/126/127.
    console.log('[ViewerOne] ESP32 reported boot/reset — resending display state')
    broadcastEsp32DisplayIfEnabled()
  }
  if (evt === 'led' && msg['ok'] === true) {
    applyLedPatternFromEsp(msg['name'])
  }
}

function syncEsp32SerialFromStore(): void {
  const st = getState(store)
  esp32Display = {
    connection: st.esp32Enabled ? 'searching' : 'disabled',
    device: 'unknown',
    model: null,
    width: null,
    height: null
  }
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
      const promptPc = wireProgram + 1
      if (
        promptPc === MIDI_PC_PROMPT_1_ON ||
        promptPc === MIDI_PC_PROMPT_1_OFF ||
        promptPc === MIDI_PC_PROMPT_2_ON ||
        promptPc === MIDI_PC_PROMPT_2_OFF
      ) {
        console.log(`[ViewerOne] MIDI: PC ${promptPc} (prompt indicator) ch ${channel0 + 1}`)
        applyPromptPc(promptPc)
        return
      }
      if (wireProgram === MIDI_PC_LED_BLACKOUT - 1) {
        console.log(`[ViewerOne] MIDI: PC ${MIDI_PC_LED_BLACKOUT} (LED blackout) ch ${channel0 + 1}`)
        applyLedBlackout()
        return
      }
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
      latestSongProgram = pc
      songIdentityRevision++
      const s = getState(store)
      const row = s.setlist.find((r) => r.program === pc)
      if (row) {
        // Display + queue only — LEDs change via PC 125/126/127.
        console.log(`[ViewerOne] MIDI: song PC ${pc} → "${row.title}" (ch ${channel0 + 1})`)
        const sameSongRefired = s.currentSongId === row.id
        setState(store, { currentSongId: row.id })
        // A new song waits at full length. Re-firing the same PC resets it and preserves play/pause.
        resetCountdownForSong(row.id, sameSongRefired && countdownRunning)
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
    },
    onNoteOn: (msg) => {
      if (msg.channel !== CUBASE_TRANSPORT_CHANNEL - 1) return
      if (msg.note === CUBASE_TRANSPORT_START_NOTE) handleTransportStart('note')
      else if (msg.note === CUBASE_TRANSPORT_STOP_NOTE) handleTransportStop('note')
    },
    onSystemRealtimeStart: () => handleTransportStart('realtime'),
    onSystemRealtimeStop: () => handleTransportStop('realtime'),
    onSysexBytes: (bytes) => {
      const command = parseMmcTransportCommand(bytes)
      if (command === 'play') handleTransportStart('MMC')
      else if (command === 'stop') handleTransportStop('MMC')
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

function setArrangerScan(patch: Partial<ArrangerScanState>): void {
  arrangerScan = { ...arrangerScan, ...patch }
  broadcastUiState()
}

function sendArrangerCommand(
  direction: 'prev' | 'next',
  log = true,
  noteDurationMs = 60
): void {
  const mapping = getState(store).arrangerMidi
  const number = direction === 'prev' ? mapping.prevNumber : mapping.nextNumber
  if (log) {
    console.log(
      `[ViewerOne] MIDI: Arranger ${direction} → ${mapping.mode === 'note' ? 'Note' : 'CC'} ${number}, ch ${mapping.channel}, port "${cubaseOutputName ?? '(no output port)'}"`
    )
  }
  if (mapping.mode === 'note') midi.sendNotePulse(mapping.channel, number, 127, noteDurationMs)
  else midi.sendControlChange(mapping.channel, number, 127)
}

/**
 * Cubase does not expose an absolute "first Arranger event" command. A bounded burst of very
 * fast Previous commands is deterministic for normal set sizes and avoids relying on PCs being
 * unique. The initial burst can be cancelled; the final restore intentionally always completes.
 */
async function rewindArrangerToBeginning(respectCancel: boolean): Promise<boolean> {
  console.log(
    `[ViewerOne] Arranger scan: rewinding with ${ARRANGER_REWIND_PULSES} fast Previous pulses (${ARRANGER_REWIND_PULSE_INTERVAL_MS}ms apart)`
  )
  for (let pulse = 0; pulse < ARRANGER_REWIND_PULSES; pulse++) {
    if (respectCancel && arrangerScanCancelled) {
      console.log(`[ViewerOne] Arranger scan: initial rewind cancelled after ${pulse} Previous pulses`)
      return false
    }
    sendArrangerCommand('prev', false, ARRANGER_REWIND_NOTE_DURATION_MS)
    if (pulse < ARRANGER_REWIND_PULSES - 1) {
      await sleep(ARRANGER_REWIND_PULSE_INTERVAL_MS)
    }
  }

  const deadline = Date.now() + ARRANGER_REWIND_SETTLE_MS
  while (Date.now() < deadline) {
    if (respectCancel && arrangerScanCancelled) return false
    await sleep(Math.min(50, deadline - Date.now()))
  }
  return true
}

async function waitForSongIdentityChange(
  _fromProgram: number,
  revisionAtSend: number,
  respectCancel: boolean
): Promise<number | null> {
  const deadline = Date.now() + ARRANGER_CHANGE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (respectCancel && arrangerScanCancelled) return null
    if (
      songIdentityRevision > revisionAtSend &&
      latestSongProgram !== null
    ) {
      return latestSongProgram
    }
    await sleep(50)
  }
  return null
}

async function waitForArrangerSettle(respectCancel: boolean): Promise<boolean> {
  const deadline = Date.now() + ARRANGER_SETTLE_MS
  while (Date.now() < deadline) {
    if (respectCancel && arrangerScanCancelled) return false
    await sleep(Math.min(50, deadline - Date.now()))
  }
  return true
}

async function stepArrangerUntilChanged(
  direction: 'prev' | 'next',
  fromProgram: number,
  respectCancel: boolean
): Promise<number | null> {
  for (let attempt = 1; attempt <= ARRANGER_NO_CHANGE_ATTEMPTS; attempt++) {
    if (respectCancel && arrangerScanCancelled) return null
    const revisionAtSend = songIdentityRevision
    sendArrangerCommand(direction)
    const changed = await waitForSongIdentityChange(fromProgram, revisionAtSend, respectCancel)
    if (changed !== null) {
      // Give Cubase's Arranger selection, title, and related automation time to settle
      // before issuing another Next/Prev command.
      if (!(await waitForArrangerSettle(respectCancel))) return null
      return changed
    }
    if (respectCancel && arrangerScanCancelled) return null
    console.log(
      `[ViewerOne] Arranger scan: ${direction} produced no song change (${attempt}/${ARRANGER_NO_CHANGE_ATTEMPTS})`
    )
  }
  return null
}

function buildScannedSetlist(programs: number[], previous: SetlistItem[]): SetlistItem[] {
  const byProgram = new Map<number, SetlistItem>()
  for (const row of previous) {
    if (!byProgram.has(row.program)) byProgram.set(row.program, row)
  }
  const usedIds = new Set<string>()
  const scannedPrograms = new Set(programs)
  const scanned = programs.map((program, index) => {
    const old = byProgram.get(program)
    const canReuseId = old && !usedIds.has(old.id)
    const id = canReuseId ? old.id : crypto.randomUUID()
    usedIds.add(id)
    return {
      id,
      program,
      arrangerIndex: index + 1,
      title: old?.title || `Song PC ${program}`,
      length: old?.length ?? '',
      year: old?.year ?? '',
      // Preserve editable metadata and every custom pick keyed by Cubase's stable song program.
      ledPattern: clampLedPatternId(old?.ledPattern ?? songLedPatternForIndex())
    }
  })
  // A scan only proves the order of songs Cubase actually visited. Keep every unvisited,
  // unique-PC row at the bottom so a partial Arranger chain cannot erase unrelated songs.
  const retainedPrograms = new Set(scannedPrograms)
  const unvisited = previous
    .filter((row) => {
      if (usedIds.has(row.id) || retainedPrograms.has(row.program)) return false
      retainedPrograms.add(row.program)
      return true
    })
    .map((row) => ({ ...row, arrangerIndex: null }))
  return [...scanned, ...unvisited]
}

function scannedSongTitle(program: number, setlist: SetlistItem[]): string | null {
  const title = setlist.find((row) => row.program === program)?.title.trim()
  return title || null
}

async function runArrangerScan(): Promise<void> {
  if (arrangerScan.active) return
  const before = getState(store)
  if (!cubaseInputOpen || !cubaseOutputOpen) {
    setArrangerScan({
      active: false,
      phase: 'error',
      collected: 0,
      message: 'Cubase MIDI input and output must both be connected before scanning.'
    })
    return
  }

  arrangerScanCancelled = false
  setArrangerScan({
    active: true,
    phase: 'scanning',
    collected: 0,
    message: `Rewinding to the first Arranger event (${ARRANGER_REWIND_PULSES} fast Previous pulses)…`
  })

  const initialRewindCompleted = await rewindArrangerToBeginning(true)
  if (!initialRewindCompleted || arrangerScanCancelled) {
    const stopReason = 'Scan stopped: cancelled by user'
    console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
    // Cancellation remains bounded: finish one deterministic rewind so the user still lands at
    // the beginning rather than wherever the interrupted burst happened to stop.
    setArrangerScan({
      active: true,
      phase: 'returning',
      collected: 0,
      message: 'Scan cancelled; returning to the beginning…'
    })
    await rewindArrangerToBeginning(false)
    setArrangerScan({
      active: false,
      phase: 'cancelled',
      collected: 0,
      message: `${stopReason} — Arranger returned to the beginning.`
    })
    return
  }

  const currentRow = before.currentSongId
    ? before.setlist.find((row) => row.id === before.currentSongId)
    : null
  const startProgram = latestSongProgram ?? currentRow?.program ?? null
  if (startProgram === null || startProgram < 1 || startProgram > MIDI_PC_SONG_MAX) {
    setArrangerScan({
      active: false,
      phase: 'error',
      collected: 0,
      message: 'Reached the beginning, but received no song Program Change from Cubase. Previous setlist kept.'
    })
    return
  }

  const programs = [startProgram]
  const seenPrograms = new Set(programs)
  let currentProgram = startProgram
  let stopReason: string | null = null
  setArrangerScan({
    active: true,
    phase: 'scanning',
    collected: 1,
    message: `Scanning from PC ${startProgram}…`
  })

  while (!arrangerScanCancelled && programs.length < MIDI_PC_SONG_MAX) {
    const nextProgram = await stepArrangerUntilChanged('next', currentProgram, true)
    if (arrangerScanCancelled) break
    if (nextProgram === null) {
      const title = scannedSongTitle(currentProgram, before.setlist) ?? `Song PC ${currentProgram}`
      stopReason =
        `Scan stopped: ${ARRANGER_NO_CHANGE_ATTEMPTS}× Next with no song change after ` +
        `'${title}' (PC ${currentProgram}) — Cubase may be at end, or next event sends no ViewerOne MIDI`
      console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
      break
    }
    currentProgram = nextProgram
    if (seenPrograms.has(currentProgram)) {
      const title = scannedSongTitle(currentProgram, before.setlist)
      stopReason =
        `Scan stopped: song PC ${currentProgram}${title ? ` (${title})` : ''} already seen earlier — ` +
        'possible duplicate Program Change in Cubase arranger'
      console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
      break
    }
    programs.push(currentProgram)
    seenPrograms.add(currentProgram)
    setArrangerScan({
      collected: programs.length,
      message: `Collected ${programs.length} songs · latest PC ${currentProgram}`
    })
  }
  if (!arrangerScanCancelled && programs.length >= MIDI_PC_SONG_MAX && !stopReason) {
    stopReason = `Scan stopped: safety limit of ${MIDI_PC_SONG_MAX} unique song PCs reached`
    console.warn(`[ViewerOne] Arranger scan: ${stopReason}`)
  }

  const wasCancelled = arrangerScanCancelled
  if (wasCancelled) {
    stopReason = 'Scan stopped: cancelled by user'
    console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
    // Allow an already-sent Next command to deliver its normal song PC before restoring.
    await sleep(250)
    if (latestSongProgram !== null) currentProgram = latestSongProgram
  }

  setArrangerScan({
    active: true,
    phase: 'returning',
    collected: programs.length,
    message: `Returning to the first Arranger event (PC ${startProgram})…`
  })
  await rewindArrangerToBeginning(false)
  currentProgram = latestSongProgram ?? currentProgram
  const restored = currentProgram === startProgram
  console.log(
    restored
      ? `[ViewerOne] Arranger scan: rewind complete at first song PC ${startProgram}`
      : `[ViewerOne] Arranger scan: rewind finished but identity is PC ${currentProgram}; expected first song PC ${startProgram}`
  )

  if (wasCancelled) {
    setArrangerScan({
      active: false,
      phase: 'cancelled',
      collected: programs.length,
      message: restored
        ? `${stopReason} — Arranger returned to the starting song.`
        : `${stopReason} — could not confirm return to the starting song.`
    })
    return
  }

  if (programs.length < 2) {
    setArrangerScan({
      active: false,
      phase: 'error',
      collected: programs.length,
      message: `${stopReason ?? 'Scan stopped: no song changes received'} — previous setlist kept.`
    })
    return
  }

  const scanned = buildScannedSetlist(programs, before.setlist)
  const startRow = scanned.find((row) => row.program === startProgram)
  setState(store, {
    setlist: scanned,
    currentSongId: startRow?.id ?? null
  })
  resetCountdownForSong(startRow?.id ?? null)
  broadcastState()
  setArrangerScan({
    active: false,
    phase: restored ? 'complete' : 'error',
    collected: programs.length,
    message: restored
      ? `${stopReason ?? 'Scan stopped'} — saved ${programs.length} in arranger order; returned to PC ${startProgram}.`
      : `${stopReason ?? 'Scan stopped'} — saved ${programs.length}, but could not confirm return to PC ${startProgram}.`
  })
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
  const attempts = 6
  for (let attempt = 0; attempt < attempts; attempt++) {
    connectMidi()
    const cubaseOk = cubaseInputOpen && cubaseOutputOpen
    if (cubaseOk) return
    if (attempt < attempts - 1) {
      console.log(
        `[ViewerOne] MIDI: refresh retry ${attempt + 1}/${attempts - 1} — Cubase input/output pair not fully open yet`
      )
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
      program: Math.max(1, Math.min(MIDI_PC_SONG_MAX, Math.round(Number(row.program) || 1))),
      arrangerIndex:
        typeof row.arrangerIndex === 'number' && Number.isFinite(row.arrangerIndex)
          ? Math.max(1, Math.round(row.arrangerIndex))
          : null,
      title: String(row.title ?? ''),
      length: normalizeSongLength(row.length),
      year: String(
        row.year ?? (row as SetlistItem & { chords?: string }).chords ?? ''
      ),
      ledPattern: clampLedPatternId(row.ledPattern)
    }))
    const st = getState(store)
    const still =
      st.currentSongId && withIds.some((r) => r.id === st.currentSongId)
        ? st.currentSongId
        : null
    setState(store, { setlist: withIds, currentSongId: still })
    if (!countdownRunning) resetCountdownForSong(still)
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:add', () => {
    const st = getState(store)
    const usedPrograms = new Set(st.setlist.map((row) => row.program))
    let program = 1
    while (program <= MIDI_PC_SONG_MAX && usedPrograms.has(program)) program++
    if (program > MIDI_PC_SONG_MAX) return buildPublicState()
    const next = [
      ...st.setlist,
      newSetlistItem({ program, ledPattern: songLedPatternForIndex(st.setlist.length) })
    ]
    setState(store, { setlist: next })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:remove', (_e, id: string) => {
    const st = getState(store)
    const next = st.setlist.filter((r) => r.id !== id)
    const nextSong = st.currentSongId === id ? null : st.currentSongId
    setState(store, { setlist: next, currentSongId: nextSong })
    if (nextSong !== st.currentSongId) resetCountdownForSong(nextSong)
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('settings:patch', (_e, patch: Partial<AppState>) => {
    if (!patch || typeof patch !== 'object') return buildPublicState()
    const st = getState(store)
    const allowed: Partial<AppState> = {}
    // fxMuted goes through applyFxMuted for CC out + display tint (not LEDs).
    const mutedToApply = patch.fxMuted !== undefined ? Boolean(patch.fxMuted) : undefined
    if (patch.allMuted !== undefined) allowed.allMuted = Boolean(patch.allMuted)
    if (patch.esp32Enabled !== undefined) allowed.esp32Enabled = Boolean(patch.esp32Enabled)
    if (patch.arrangerMidi && typeof patch.arrangerMidi === 'object') {
      const raw = patch.arrangerMidi
      allowed.arrangerMidi = {
        mode: raw.mode === 'cc' ? 'cc' : 'note',
        channel: Math.max(1, Math.min(16, Math.round(Number(raw.channel) || st.arrangerMidi.channel))),
        prevNumber: Math.max(0, Math.min(127, Math.round(Number(raw.prevNumber) || 0))),
        nextNumber: Math.max(0, Math.min(127, Math.round(Number(raw.nextNumber) || 0)))
      }
    }

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

  ipcMain.handle('arranger:prev', () => {
    if (!arrangerScan.active) sendArrangerCommand('prev')
    return buildPublicState()
  })

  ipcMain.handle('arranger:next', () => {
    if (!arrangerScan.active) sendArrangerCommand('next')
    return buildPublicState()
  })

  ipcMain.handle('arranger:scan', () => {
    if (!arrangerScan.active) void runArrangerScan()
    return buildPublicState()
  })

  ipcMain.handle('arranger:cancelScan', () => {
    if (arrangerScan.active) {
      arrangerScanCancelled = true
      setArrangerScan({ message: 'Cancelling; returning to the starting song…' })
    }
    return buildPublicState()
  })

  /** Simulate absolute CrowPanel prompt PCs 120–123 through the real receive/serial path. */
  ipcMain.handle('prompt:midi', (_e, pc: unknown) => {
    if (
      pc === MIDI_PC_PROMPT_1_ON ||
      pc === MIDI_PC_PROMPT_1_OFF ||
      pc === MIDI_PC_PROMPT_2_ON ||
      pc === MIDI_PC_PROMPT_2_OFF
    ) {
      applyPromptPc(pc)
    }
    return buildPublicState()
  })

  /** Simulate Cubase PC 125 (LED blackout) — same path as real MIDI. */
  ipcMain.handle('led:midiBlackout', () => {
    applyLedBlackout()
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
    resetCountdownForSong(row.id)
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
    resetCountdownForSong(row.id)
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
    resetCountdownForSong(setlist[nextIdx].id)
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
    resetCountdownForSong(setlist[nextIdx].id)
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('setlist:selectSong', (_e, id: unknown) => {
    const st = getState(store)
    if (id === null || id === undefined || id === '') {
      setState(store, { currentSongId: null })
      resetCountdownForSong(null)
      broadcastState()
      return buildPublicState()
    }
    if (typeof id !== 'string') return buildPublicState()
    if (!st.setlist.some((r) => r.id === id)) return buildPublicState()
    setState(store, { currentSongId: id })
    resetCountdownForSong(id)
    broadcastState()
    return buildPublicState()
  })
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
    resetCountdownForSong(getState(store).currentSongId)
    startCountdownTicker()
    setEsp32LineHandler(handleEsp32Line)
    setEsp32ConnectionHandler((connected) => {
      const enabled = getState(store).esp32Enabled
      esp32Display = {
        connection: !enabled ? 'disabled' : connected ? 'connected' : 'searching',
        device: 'unknown',
        model: null,
        width: null,
        height: null
      }
      if (!isQuitting) broadcastUiState()
    })
    registerIpc()
    connectMidi()
    if (!cubaseInputOpen || !cubaseOutputOpen) {
      scheduleMidiReconnect('startup Cubase ports not fully open')
    }
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
    stopCountdownTicker()
    shutdownEsp32Serial()
    midi.closeInput()
    midi.closeMixerInput()
    midi.closeMixerOutput()
    midi.closeOutput()
  })
}
