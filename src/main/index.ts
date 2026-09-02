import { installProcessGuards } from './processGuards.js'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { setupAppMenu } from './menu.js'
import { existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampCountdownStartLeadMs,
  createAppStore,
  getState,
  setState,
  newSetlistItem
} from './store.js'
import { MidiService, listInputs, listOutputs, parseMmcTransportCommand } from './midi.js'
import {
  pushEsp32Payload,
  pushEsp32HelloRequest,
  pushEsp32LedPattern,
  pushEsp32LedBrightness,
  pushEsp32Prompt,
  pushEsp32Clock,
  setEsp32ConnectionHandler,
  setEsp32LineHandler,
  setEsp32SerialPort,
  shutdownEsp32SerialAsync,
  type Esp32FromDeviceMsg
} from './esp32Bridge.js'
import {
  dmxBlackout,
  dmxSetChannels,
  getDmxStatus,
  setDmxConnectionHandler,
  setDmxEnabled,
  shutdownDmxSerialAsync
} from './dmxBridge.js'
import { dmxUniverseForLedPattern, dmxUniverseForLook, DMX_RANDOM_ROTATE_MS, DMX_STICK_FRAME_MS, type DmxLook } from '../shared/dmx.js'
import { mergeDmxCueOverrides } from '../shared/dmxCue.js'
import type { DmxCueOverride, LightingCue } from '../shared/lightingProgram.js'
import type { LightingReadinessReport } from '../shared/lightingReadiness.js'
import { auditLightingReadiness } from '../shared/lightingReadiness.js'
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
  CUBASE_MIDI_SPY_LIMIT,
  CUBASE_MUTE_CHANNEL,
  CUBASE_MUTE_CC,
  CUBASE_ALL_MUTE_CC,
  CUBASE_SYNTH_MUTE_CC,
  CUBASE_PIANO_MUTE_CC,
  CUBASE_CHANNEL_MUTE_INVERTED,
  MUTE_ECHO_IGNORE_MS,
  cubaseMuteCcValue,
  mixerMuteCcValue,
  ccValueToMuted,
  ccValueToMixerMuted,
  MIXER_MUTE_CHANNEL,
  isMixerMuteCc,
  BRIDGED_MUTES,
  bridgedMuteByCubaseCc,
  bridgedMuteByMixerCc,
  bridgedMuteByEspGroup,
  type BridgedMuteDef,
  type BridgedMuteId,
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
  LightingAnalyzeScanState,
  MidiSpyEvent,
  PublicState,
  SetlistItem,
  TransportMidiMapping
} from '../shared/types.js'
import {
  auditSetlistLengths,
  countNumberedArrangerSongs,
  calculateSetlistTiming,
  formatSetlistSeconds,
  normalizeSongLength,
  scanIsGigReady,
  songLengthSeconds,
  isSoundcheckTitle
} from '../shared/setlistTiming.js'
import {
  CUBASE_AUTO_LENGTH_PASS,
  checkCubaseAlive,
  isDuplicateLengthGarbage,
  isKeepableLengthForTitle,
  prepareCubaseWindowForCapture,
  expandCubaseArrangerLayout,
  readCubaseLengthForEvent,
  shutdownCubaseLengthCapture
} from './cubaseLengthCapture.js'
import { LightingDirector } from './lightingDirector.js'
import { runLightingAnalyzePass } from './lightingAnalyzePass.js'
import { normalizeSongAudioAnalysis } from '../shared/audioAnalysisNormalize.js'
import { formatViewerOneVersion } from '../shared/appVersion.js'
import { listWindowsAudioDevices } from './listAudioDevices.js'
import { LoopbackMeter } from './loopbackMeter.js'
import type { LoopbackMeterSample } from '../shared/audioLevel.js'
import { resolveLoopbackDevice } from '../shared/dshowAudioDevices.js'

// Must run before any MIDI/serial traffic — EPIPE on stdout used to kill the main process mid-gig.
installProcessGuards()

if (process.platform === 'win32') {
  app.setAppUserModelId('com.viewerone.app')
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function preloadScriptPath(): string {
  const mjs = join(__dirname, '../preload/index.mjs')
  if (existsSync(mjs)) return mjs
  return join(__dirname, '../preload/index.js')
}

let controlWindow: BrowserWindow | null = null
const store = createAppStore()
const lightingDirector = new LightingDirector()
const loopbackMeter = new LoopbackMeter((sample) => broadcastLoopbackMeter(sample))

let dmxCueOverride: DmxCueOverride | undefined
let dmxStickBrightnessScale = 1

function applyDirectorCue(cue: LightingCue): void {
  const id = clampLedPatternId(cue.ledPatternId)
  const st = getState(store)
  ledIdleDimActive = false
  ledPattern = ledPatternName(id)
  dmxCueOverride = cue.dmx
  dmxStickBrightnessScale = cue.dmx?.stickBrightnessScale ?? 1
  const look = cue.dmxLook
  if (look) {
    dmxLook = look
    if (look === 'off') stopDmxRandomRotator()
    else if (look === 'idle') stopDmxRandomRotator()
    else armDmxForLedPattern(id)
  } else {
    armDmxForLedPattern(id)
  }
  const bright =
    cue.brightness !== undefined
      ? clampLedBrightness(cue.brightness, st.ledExternalPower)
      : st.ledBrightness
  if (st.esp32Enabled) {
    pushEsp32LedPattern(id)
    pushEsp32LedBrightness(bright)
  }
  refreshDmxOutput()
  broadcastUiState()
}

lightingDirector.setApplyCue(applyDirectorCue)

let lightingDirectorTimer: ReturnType<typeof setInterval> | null = null

function songPerformanceMs(now = Date.now()): number | null {
  const st = getState(store)
  if (!st.currentSongId || countdownSongId !== st.currentSongId) return null
  if (countdownTotalSeconds > 0) {
    const remaining = countdownRunning ? countdownRemainingNowMs(now) : countdownRemainingMs
    return Math.max(0, countdownTotalSeconds * 1000 - remaining)
  }
  const row = st.setlist.find((r) => r.id === st.currentSongId)
  return row?.audioAnalysis?.durationMs ?? null
}

function startPerformanceSyncTicker(): void {
  if (lightingDirectorTimer) return
  lightingDirectorTimer = setInterval(() => tickPerformanceSync(), 50)
  lightingDirectorTimer.unref()
}

function stopPerformanceSyncTicker(): void {
  if (!lightingDirectorTimer) return
  clearInterval(lightingDirectorTimer)
  lightingDirectorTimer = null
}

function tickPerformanceSync(now = Date.now()): void {
  const perf = songPerformanceMs(now)
  if (perf == null) return
  const st = getState(store)
  if (st.lightingDirectorEnabled) {
    lightingDirector.tick(perf)
  }
}

function armLightingDirectorForCurrentSong(): void {
  const st = getState(store)
  if (!st.lightingDirectorEnabled) {
    lightingDirector.disarm()
    return
  }
  const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
  if (!row?.lightingProgram?.cues?.length) {
    lightingDirector.disarm()
    return
  }
  lightingDirector.arm(row, st.liveAudioSyncEnabled, st.lightingLoopbackDevice)
  tickPerformanceSync()
}

function updateSetlistRow(songId: string, patch: Partial<SetlistItem>): void {
  const st = getState(store)
  const next = st.setlist.map((row) => (row.id === songId ? { ...row, ...patch } : row))
  setState(store, { setlist: next })
}
const midi = new MidiService()

/** Set once we intentionally shut down — blocks MIDI auto-reconnect from resurrecting a headless process. */
let isQuitting = false
/** True after native MIDI/serial/OCR handles have been closed — allows app.quit() to proceed. */
let shutdownFinished = false
let shutdownPromise: Promise<void> | null = null

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
  if (shutdownFinished) {
    app.quit()
    return
  }
  if (shutdownPromise) return
  isQuitting = true
  arrangerScanCancelled = true
  shutdownPromise = shutdownViewerOneResources().finally(() => {
    shutdownFinished = true
    app.quit()
    // Only if a native addon kept the event loop alive after a clean close.
    setTimeout(() => app.exit(0), 4000).unref()
  })
}

async function shutdownViewerOneResources(): Promise<void> {
  isQuitting = true
  arrangerScanCancelled = true
  clearMidiReconnectTimer()
  stopCountdownTicker()
  stopPerformanceSyncTicker()
  loopbackMeter.stop()
  lightingDirector.shutdown()
  clearEsp32DisplayCoalesceTimer()
  stopEsp32ClockSync()
  stopDmxRandomRotator()
  stopDmxStickAnimator()
  try {
    midi.flushPendingNoteOffs()
  } catch {
    /* ignore */
  }
  await shutdownCubaseLengthCapture()
  await shutdownEsp32SerialAsync()
  await shutdownDmxSerialAsync()
  try {
    midi.closeInput()
    midi.closeMixerInput()
    midi.closeMixerOutput()
    midi.closeOutput()
  } catch {
    /* ignore — quitting anyway */
  }
}

/**
 * Echo ignore keyed by source+CC (`cubase:88`, `mixer:80`) — never bare CC alone.
 * Cubase ALL CC88 and mixer MG1 CC80 must not share a key (that collision caused the flash loop).
 */
type MuteEchoSource = 'cubase' | 'mixer'
const muteSentBySourceCc = new Map<string, { value: number; atMs: number }>()
function muteEchoKey(source: MuteEchoSource, controller: number): string {
  return `${source}:${controller}`
}
let muteBootSyncTimer: ReturnType<typeof setTimeout> | null = null
let muteBootSyncFollowUpTimer: ReturnType<typeof setTimeout> | null = null

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
/** Remaining at the moment play/continue began — wall-clock anchor while Playing. */
let countdownAnchorRemainingMs = 0
let countdownLastPublishedSecond: number | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null
/** Cubase transport latch — Start/Stop even when no song is selected for countdown. */
let transportPlaying = false
let lastTransportEvent: {
  action: 'start' | 'continue' | 'stop'
  source: string
  at: number
} | null = null
/** Recent CubaseToViewerOne inbound messages for the Live status MIDI spy. */
let cubaseSpy: MidiSpyEvent[] = []
/** Suggestion when Play is heard on a mismatched note/CC/channel (or missing entirely). */
let transportHint: string | null = null
let realtimeTransportSeen = false

/** MIDI clock is 24 pulses per quarter note. */
const MIDI_CLOCK_PPQN = 24
/**
 * Soft-start after this many post-silence ticks while Stopped.
 * 1 = first 0xF8 after silence ⇒ Playing immediately (do not wait for late 0xFA).
 */
const MIDI_CLOCK_SOFT_START_TICKS = 1
/**
 * Gap that means "clock was silent". Next tick while Stopped starts a new burst
 * (Cubase often begins 0xF8 before a bar-quantized 0xFA).
 */
const MIDI_CLOCK_SILENCE_MS = 200
/** Ignore inter-tick gaps larger than this (ms) when estimating tempo. */
const MIDI_CLOCK_MAX_GAP_MS = 500
/** Heavy EMA for optional BPM correction — Windows tick gaps are noisy. */
const MIDI_CLOCK_PERIOD_EMA = 0.02
/** Apply at most one light MIDI-clock nudge per second. */
const MIDI_CLOCK_CORRECT_INTERVAL_MS = 1000
/** Max ms pulled off the display remaining per correction tick. */
const MIDI_CLOCK_CORRECT_MAX_MS = 120
/** Start soon after a soft clock-start must not look like a mid-song restart. */
const TRANSPORT_RESTART_GUARD_MS = 300

let midiClockLastTickAtMs: number | null = null
/** Heavily smoothed tick period (ms); optional correction only — not the display driver. */
let midiClockTickPeriodMs: number | null = null
let midiClockTicksSincePlay = 0
/** Counts ticks in the current post-silence burst while Stopped — used for soft-start. */
let midiClockStoppedStreak = 0
/** Ignore trailing clock ticks right after Stop so we don't soft-resume. */
let midiClockSoftStartArmedAtMs = 0
/** Extra elapsed applied from rare MIDI-clock nudges (never negative). */
let countdownClockBiasMs = 0
let countdownLastClockCorrectAtMs = 0
/** Song Position Pointer in MIDI beats (1 beat = 6 clocks = one 16th note). */
let lastSongPositionMidiBeats: number | null = null
let lastSongPositionAtMs: number | null = null
/** Only honor SPP=0 as "rewound to start" when the pointer arrived recently. */
const SPP_REWIND_WINDOW_MS = 600
/** Drop trailing 0xF8 after Stop before arming soft-start on the next burst. */
const MIDI_CLOCK_SOFT_START_GUARD_MS = 250

/** Mirrors ESP LED pattern for the desktop preview (synced via boot / led serial events / MIDI LED PCs). */
let ledPattern = 'knight_rider'

/** Ephemeral hardware identity. The renderer simulates CrowPanel unless hardware identifies as CYD. */
let esp32Display: Esp32DisplayStatus = {
  connection: 'disabled',
  device: 'unknown',
  model: null,
  width: null,
  height: null,
  fw: null
}

/** DMX look follows LED events: PC 125 off, PC 126 idle, PC 127 per-pattern (random rotates with ESP). */
let dmxLook: DmxLook = 'off'
let dmxLedPatternId = 0
let dmxRandomTimer: ReturnType<typeof setInterval> | null = null
let dmxRandomChild = 1
let dmxStickTimer: ReturnType<typeof setInterval> | null = null
let dmxStickT0 = 0
let dmxStickLastPattern = -1

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

/** Max wait for Cubase to send a *different* song PC after Next/Prev (returns sooner). */
const ARRANGER_CHANGE_TIMEOUT_MS = 2200
const ARRANGER_NO_CHANGE_ATTEMPTS = 5
/** Extra wait after a PC change so the Arranger event (not a MIDI clip) is painted before we screenshot. */
const ARRANGER_SETTLE_MS = 220
const ARRANGER_REWIND_PULSES = 80
const ARRANGER_REWIND_PULSE_INTERVAL_MS = 55
const ARRANGER_REWIND_NOTE_DURATION_MS = 40
const ARRANGER_REWIND_SETTLE_MS = 800
const ARRANGER_IDENTITY_POLL_MS = 20
const ARRANGER_LENGTH_RETRY_GAP_MS = 180
const ARRANGER_LENGTH_ATTEMPTS = 3
let latestSongProgram: number | null = null
let songIdentityRevision = 0
let arrangerScanCancelled = false
let arrangerScanPromise: Promise<void> | null = null
let arrangerScan: ArrangerScanState = {
  active: false,
  phase: 'idle',
  collected: 0,
  message: 'Ready'
}

let lightingAnalyzeCancelled = false
let lightingAnalyzePromise: Promise<void> | null = null
let lightingAnalyze: LightingAnalyzeScanState = {
  active: false,
  phase: 'idle',
  collected: 0,
  total: 0,
  message: 'Ready'
}

function setLightingAnalyze(patch: Partial<LightingAnalyzeScanState>): void {
  lightingAnalyze = { ...lightingAnalyze, ...patch }
  broadcastUiState()
}

/** Isolated Cubase play for render capture — does not arm gig countdown. */
function sendAnalyzePlay(): void {
  if (!cubaseOutputOpen) return
  const mapping = getState(store).transportMidi
  const ch = mapping.channel >= 1 && mapping.channel <= 16 ? mapping.channel : 16
  console.log('[ViewerOne] Lighting analyze: Cubase Play (isolated)')
  if (mapping.mode === 'note') midi.sendNotePulse(ch, mapping.startNumber, 127, 80)
  else midi.sendControlChange(ch, mapping.startNumber, 127)
}

function sendAnalyzeStop(): void {
  sendCubaseTransportStop('lighting analyze capture')
}

async function runLightingAnalyzeFromCubase(
  maxCaptures?: number,
  onlyTitle?: string,
  onlyProgram?: number
): Promise<void> {
  if (lightingAnalyzePromise) return
  if (arrangerScanPromise || arrangerScan.active) {
    setLightingAnalyze({
      active: false,
      phase: 'error',
      message: 'Arranger scan is running — wait for it to finish.'
    })
    return
  }
  lightingAnalyzeCancelled = false
  const st = getState(store)
  let loopbackDevice = st.lightingLoopbackDevice || 'Stereo Mix'
  try {
    const devices = await listWindowsAudioDevices()
    loopbackDevice = resolveLoopbackDevice(loopbackDevice, devices) ?? loopbackDevice
  } catch {
    /* keep saved name */
  }
  loopbackMeter.pauseExclusive()
  lightingAnalyzePromise = runLightingAnalyzePass({
    getSetlist: () => getState(store).setlist,
    updateRow: updateSetlistRow,
    setScan: (patch) => setLightingAnalyze(patch),
    isCancelled: () => lightingAnalyzeCancelled,
    sleep,
    sendArrangerCommand: (dir) => sendArrangerCommand(dir),
    rewindArranger: async () => {
      await rewindArrangerToBeginning(false)
    },
    waitForProgramChange: (from) => stepArrangerUntilChanged('next', from, false),
    getLatestProgram: () => latestSongProgram,
    restoreProgram: (program) => {
      const order = getState(store)
        .setlist.filter((r) => r.arrangerIndex != null)
        .sort((a, b) => (a.arrangerIndex ?? 0) - (b.arrangerIndex ?? 0))
        .map((r) => r.program)
      return restoreArrangerToProgram(program, false, order)
    },
    sendAnalyzePlay,
    sendAnalyzeStop,
    withLiveMix: async (fn) => {
      sendMuteCcToCubase(false, CUBASE_ALL_MUTE_CC)
      sendMuteCcToCubase(false, CUBASE_MUTE_CC)
      await sleep(200)
      try {
        return await fn()
      } finally {
        const cur = getState(store)
        sendMuteCcToCubase(cur.allMuted, CUBASE_ALL_MUTE_CC)
        sendMuteCcToCubase(cur.fxMuted, CUBASE_MUTE_CC)
      }
    },
    minimizeUi: async () => {
      if (controlWindow && !controlWindow.isDestroyed() && !controlWindow.isMinimized()) {
        controlWindow.minimize()
        await sleep(120)
      }
    },
    restoreUi: async () => {
      if (controlWindow && !controlWindow.isDestroyed() && controlWindow.isMinimized()) {
        controlWindow.restore()
      }
    },
    loopbackDevice,
    director: lightingDirector,
    maxCaptures,
    onlyTitle,
    onlyProgram
  })
    .catch((err) => {
      console.warn('[ViewerOne] Lighting analyze failed:', err)
      setLightingAnalyze({
        active: false,
        phase: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    })
    .finally(() => {
      lightingAnalyzePromise = null
      loopbackMeter.resumeExclusive()
      broadcastState()
    })
  await lightingAnalyzePromise
}

/**
 * Wall-clock remaining while Playing. MIDI clock may apply a small downward
 * bias (~1/sec) but never drives the display directly (tick jitter on Windows
 * made period×ticks jump residual seconds up and down).
 */
function countdownRemainingNowMs(now = Date.now()): number {
  if (!countdownRunning || countdownStartedAtMs === null) return countdownRemainingMs
  const wallElapsed = now - countdownStartedAtMs
  return Math.max(0, countdownAnchorRemainingMs - wallElapsed - countdownClockBiasMs)
}

/**
 * Display seconds: ceil for "time left", monotonic while Playing so we never
 * oscillate between N and N+1 when remaining crosses a boundary with jitter.
 * Increases are allowed only after Stop→Start/Continue resume or song reset
 * (callers clear {@link countdownLastPublishedSecond}).
 */
function countdownDisplaySeconds(now = Date.now()): number | null {
  if (countdownTotalSeconds <= 0) return null
  let sec = Math.max(0, Math.ceil(countdownRemainingNowMs(now) / 1000))
  if (countdownRunning && countdownLastPublishedSecond != null) {
    sec = Math.min(sec, countdownLastPublishedSecond)
  }
  return sec
}

function countdownSnapshot(): PublicState['countdown'] {
  const st = getState(store)
  const row = st.currentSongId ? st.setlist.find((item) => item.id === st.currentSongId) : null
  const rowTotal = row ? songLengthSeconds(row.length) : 0
  const ownsCurrentSong = Boolean(row && countdownSongId === row.id)
  const totalSeconds = ownsCurrentSong ? countdownTotalSeconds : rowTotal
  const remainingSeconds =
    totalSeconds > 0 ? (ownsCurrentSong ? countdownDisplaySeconds() : totalSeconds) : null
  return {
    running: countdownRunning && ownsCurrentSong,
    display: remainingSeconds === null ? '' : formatSetlistSeconds(remainingSeconds),
    remainingSeconds,
    totalSeconds: totalSeconds > 0 ? totalSeconds : null
  }
}

function countdownIsAtFullLength(): boolean {
  if (countdownTotalSeconds <= 0) return false
  return countdownRemainingMs >= countdownTotalSeconds * 1000 - 50
}

function resetCountdownForSong(songId: string | null, keepRunning = false): void {
  const st = getState(store)
  const row = songId ? st.setlist.find((item) => item.id === songId) : null
  const now = Date.now()
  countdownSongId = row?.id ?? null
  countdownTotalSeconds = row ? songLengthSeconds(row.length) : 0
  countdownRemainingMs = countdownTotalSeconds * 1000
  countdownAnchorRemainingMs = countdownRemainingMs
  countdownClockBiasMs = 0
  countdownLastClockCorrectAtMs = 0
  countdownRunning = keepRunning && countdownSongId !== null
  countdownStartedAtMs = countdownRunning ? now : null
  // Allow display to jump up to full length on song reset.
  countdownLastPublishedSecond = null
  midiClockTicksSincePlay = 0
}

function bindCountdownToCurrentSong(): void {
  const st = getState(store)
  if (countdownSongId === st.currentSongId) return
  resetCountdownForSong(st.currentSongId, false)
}

/**
 * Begin/resume wall-clock countdown. When arming from full song length, optionally
 * backdate the start by {@link AppState.countdownStartLeadMs} to absorb Cubase Start lag.
 */
function beginCountdownRunning(now: number, opts?: { applyLead?: boolean }): void {
  const st = getState(store)
  bindCountdownToCurrentSong()
  countdownRemainingMs = Math.max(0, countdownRemainingMs)
  countdownAnchorRemainingMs = countdownRemainingMs
  countdownClockBiasMs = 0
  countdownLastClockCorrectAtMs = now
  countdownRunning = st.currentSongId !== null && countdownRemainingMs > 0
  countdownStartedAtMs = countdownRunning ? now : null
  if (opts?.applyLead && countdownRunning && countdownIsAtFullLength()) {
    const lead = clampCountdownStartLeadMs(st.countdownStartLeadMs)
    if (lead > 0 && countdownStartedAtMs != null) {
      countdownStartedAtMs = now - lead
    }
  }
  // Resume / Start may show a higher remaining than the previous published second.
  countdownLastPublishedSecond = null
  midiClockTicksSincePlay = 0
  midiClockStoppedStreak = 0
}

function noteTransportHint(source: string): void {
  if (source === 'realtime' || source === 'clock') {
    realtimeTransportSeen = true
    transportHint =
      'Using MIDI Clock Start/Stop/Continue (0xFA/0xFB/0xFC) — countdown uses wall clock (light tempo nudge).'
  } else if (source === 'MMC') {
    transportHint = 'Using MMC Play/Stop — no Generic Remote notes needed.'
  }
}

/**
 * Optional ~1 Hz MIDI-clock nudge toward tempo-accurate remaining.
 * Only pulls remaining DOWN (never increases displayed time while Playing).
 */
function maybeApplyMidiClockCorrection(now: number): void {
  if (!countdownRunning || countdownStartedAtMs === null) return
  if (midiClockTickPeriodMs == null || midiClockTicksSincePlay < MIDI_CLOCK_PPQN) return
  if (now - countdownLastClockCorrectAtMs < MIDI_CLOCK_CORRECT_INTERVAL_MS) return
  countdownLastClockCorrectAtMs = now
  const wallRemaining = countdownAnchorRemainingMs - (now - countdownStartedAtMs) - countdownClockBiasMs
  const clockElapsed = midiClockTicksSincePlay * midiClockTickPeriodMs
  const clockRemaining = countdownAnchorRemainingMs - clockElapsed
  // Wall ahead of clock ⇒ we're counting too slowly; nudge down a little.
  const lagMs = wallRemaining - clockRemaining
  if (lagMs <= 40) return
  const nudge = Math.min(MIDI_CLOCK_CORRECT_MAX_MS, lagMs * 0.2)
  countdownClockBiasMs += nudge
}

/**
 * Cubase may emit mapped note + realtime/MMC + clock soft-start for one press.
 * Collapse near-simultaneous cross-protocol duplicates; keep deliberate restarts.
 */
function isDuplicateTransportEvent(
  action: 'start' | 'continue' | 'stop',
  source: string,
  now: number
): boolean {
  const previous = lastTransportEvent
  const playFamily = action === 'start' || action === 'continue'
  const prevPlayFamily =
    previous != null && (previous.action === 'start' || previous.action === 'continue')
  const isDup = Boolean(
    previous &&
      previous.source !== source &&
      now - previous.at < 120 &&
      ((action === 'stop' && previous.action === 'stop') || (playFamily && prevPlayFamily))
  )
  if (!isDup) lastTransportEvent = { action, source, at: now }
  return isDup
}

function publishCountdownIfSecondChanged(): void {
  maybeApplyMidiClockCorrection(Date.now())
  const snap = countdownSnapshot()
  if (snap.remainingSeconds === countdownLastPublishedSecond) return
  countdownLastPublishedSecond = snap.remainingSeconds
  if (snap.remainingSeconds === 0) {
    countdownRemainingMs = 0
    countdownAnchorRemainingMs = 0
    countdownClockBiasMs = 0
    countdownRunning = false
    countdownStartedAtMs = null
    midiClockTicksSincePlay = 0
    // Hit zero — push once so the device freezes at 00:00 (no per-second spam while running).
    broadcastState()
    return
  }
  // UI only — CrowPanel/CYD tick MM:SS locally from the last r/p arm; serial every second
  // was stalling WS2812 refresh.
  broadcastUiState()
}

/**
 * Start (0xFA) / mapped Start / MMC Play while already rolling:
 * reset to full length. After Stop on the same song: resume frozen remaining.
 * Song Position 0 after a partial countdown also means rewind → reset.
 */
function handleTransportStart(source: string): void {
  if (lightingAnalyze.active) return
  const now = Date.now()
  // Capture prior transport timing BEFORE debounce mutates lastTransportEvent.
  const priorPlaying = transportPlaying
  const priorRunning = countdownRunning
  const priorEvent = lastTransportEvent
  const priorPlayAt =
    priorPlaying && priorEvent && (priorEvent.action === 'start' || priorEvent.action === 'continue')
      ? priorEvent.at
      : null

  if (isDuplicateTransportEvent('start', source, now)) return
  noteTransportHint(source)
  transportPlaying = true
  bindCountdownToCurrentSong()

  const sppRecent =
    lastSongPositionAtMs != null && now - lastSongPositionAtMs < SPP_REWIND_WINDOW_MS
  const rewoundToStart = sppRecent && lastSongPositionMidiBeats === 0
  const partiallyElapsed =
    countdownTotalSeconds > 0 && countdownRemainingMs < countdownTotalSeconds * 1000 - 500
  const playingLongEnough =
    (priorPlaying || priorRunning) &&
    priorPlayAt != null &&
    now - priorPlayAt > TRANSPORT_RESTART_GUARD_MS
  const mappedStart = source === 'note' || source === 'cc'
  // Reset when exhausted, recently rewound to SPP0, or an explicit mapped Start while rolling.
  // Do NOT reset on a late realtime 0xFA after clock soft-start/Continue — that caused a ~2s "jump".
  const shouldReset =
    countdownRemainingMs <= 0 ||
    (rewoundToStart && partiallyElapsed) ||
    (mappedStart && playingLongEnough)

  if (shouldReset) {
    resetCountdownForSong(getState(store).currentSongId, false)
  } else if (priorRunning) {
    countdownRemainingMs = countdownRemainingNowMs(now)
  }
  // Lead only when arming from full length (fresh Start / rewind) — never on pause-resume.
  beginCountdownRunning(now, { applyLead: shouldReset || countdownIsAtFullLength() })
  console.log(
    `[ViewerOne] MIDI: transport Start (${source}) — playing=${transportPlaying} reset=${shouldReset} countdown=${countdownSnapshot().display || 'length unknown'}`
  )
  broadcastState()
}

/** Continue (0xFB) / clock soft-start: always resume frozen remaining, never reset. */
function handleTransportContinue(source: string): void {
  if (lightingAnalyze.active) return
  const now = Date.now()
  if (isDuplicateTransportEvent('continue', source, now)) return
  noteTransportHint(source)
  transportPlaying = true
  bindCountdownToCurrentSong()
  if (countdownRunning) {
    countdownRemainingMs = countdownRemainingNowMs(now)
  }
  let armedFromFull = false
  if (countdownRemainingMs <= 0 && countdownTotalSeconds > 0) {
    // Empty remaining on continue — arm full length once (fresh song / exhausted).
    resetCountdownForSong(getState(store).currentSongId, false)
    armedFromFull = true
  }
  beginCountdownRunning(now, { applyLead: armedFromFull || countdownIsAtFullLength() })
  console.log(
    `[ViewerOne] MIDI: transport Continue (${source}) — playing=${transportPlaying} countdown=${countdownSnapshot().display || 'length unknown'}`
  )
  broadcastState()
}

/** Stop (0xFC) / MMC pause: freeze remaining — never reset to full length. */
function handleTransportStop(source: string): void {
  if (lightingAnalyze.active) return
  const now = Date.now()
  if (isDuplicateTransportEvent('stop', source, now)) return
  noteTransportHint(source)
  // Freeze first while running flag still reflects playback.
  countdownRemainingMs = countdownRemainingNowMs(now)
  countdownAnchorRemainingMs = countdownRemainingMs
  countdownClockBiasMs = 0
  countdownRunning = false
  countdownStartedAtMs = null
  transportPlaying = false
  midiClockTicksSincePlay = 0
  midiClockStoppedStreak = 0
  midiClockLastTickAtMs = null
  midiClockSoftStartArmedAtMs = now + MIDI_CLOCK_SOFT_START_GUARD_MS
  console.log(
    `[ViewerOne] MIDI: transport Stop/Pause (${source}) — playing=${transportPlaying} froze ${countdownSnapshot().display || 'unknown'}`
  )
  broadcastState()
}

/** Lightweight 0xF8 path — soft-start + slow EMA only; display is wall-clock driven. */
function handleMidiClockTick(): void {
  const now = Date.now()
  const gap =
    midiClockLastTickAtMs != null ? now - midiClockLastTickAtMs : Number.POSITIVE_INFINITY
  if (midiClockLastTickAtMs != null && gap > 0 && gap < MIDI_CLOCK_MAX_GAP_MS) {
    // Very heavy smoothing — gap jitter must not swing countdown math.
    midiClockTickPeriodMs =
      midiClockTickPeriodMs == null
        ? gap
        : midiClockTickPeriodMs * (1 - MIDI_CLOCK_PERIOD_EMA) + gap * MIDI_CLOCK_PERIOD_EMA
  }
  midiClockLastTickAtMs = now

  if (!transportPlaying) {
    // Drop a short burst of ticks that often trail a Stop message.
    if (now < midiClockSoftStartArmedAtMs) {
      midiClockStoppedStreak = 0
      return
    }
    // Fresh burst after silence (or first tick ever) — Cubase may roll clock before 0xFA.
    if (gap >= MIDI_CLOCK_SILENCE_MS) {
      midiClockStoppedStreak = 0
    }
    midiClockStoppedStreak++
    // Instant soft-start on first post-silence tick (same feel as Stop on 0xFC).
    if (midiClockStoppedStreak >= MIDI_CLOCK_SOFT_START_TICKS) {
      handleTransportContinue('clock')
    }
    return
  }

  midiClockStoppedStreak = 0
  if (!countdownRunning) return
  midiClockTicksSincePlay++
}

function handleSongPosition(midiBeats: number): void {
  lastSongPositionMidiBeats = Math.max(0, Math.round(midiBeats))
  lastSongPositionAtMs = Date.now()
}

function pushCubaseSpy(event: MidiSpyEvent): void {
  cubaseSpy = [...cubaseSpy, event].slice(-CUBASE_MIDI_SPY_LIMIT)
  // UI-only — do not push ESP / mute side effects for every MIDI clock or note.
  broadcastUiState()
}

function channelMatchesTransport(msgChannel0: number, mapping: TransportMidiMapping): boolean {
  if (mapping.channel === 0) return true
  return msgChannel0 === mapping.channel - 1
}

/** Map configured note/CC Start/Stop; also hint when the number matches on the wrong channel. */
function tryMappedTransport(
  kind: 'note' | 'cc',
  msgChannel0: number,
  number: number,
  value: number
): void {
  const mapping = getState(store).transportMidi
  if (mapping.mode !== kind) {
    // Still hint if numbers match the configured Start/Stop while mode differs.
    if (
      (number === mapping.startNumber || number === mapping.stopNumber) &&
      value > 0 &&
      !realtimeTransportSeen
    ) {
      transportHint =
        `Saw ${kind} ${number} on ch ${msgChannel0 + 1}, but transport mode is set to ${mapping.mode}. ` +
        `Switch Transport MIDI mode to ${kind} in Detail, or route MIDI Clock/MMC to CubaseToViewerOne.`
      broadcastUiState()
    }
    return
  }
  const isStart = number === mapping.startNumber
  const isStop = number === mapping.stopNumber
  if (!isStart && !isStop) return
  // CC: ignore releases (0). Note: velocity 0 = note-off alias — ignore for Start, allow for Stop.
  if (kind === 'cc' && value <= 0) return
  if (kind === 'note' && isStart && value <= 0) return
  if (!channelMatchesTransport(msgChannel0, mapping)) {
    const want = mapping.channel === 0 ? 'any' : String(mapping.channel)
    transportHint =
      `Saw transport ${kind} ${number} on ch ${msgChannel0 + 1}, but settings expect ch ${want}. ` +
      `Set Transport channel to ${msgChannel0 + 1} (or Any) in Detail.`
    console.log(
      `[ViewerOne] MIDI: transport ${kind} ${number} on ch ${msgChannel0 + 1} ignored — need ch ${want}`
    )
    broadcastUiState()
    return
  }
  if (isStart) handleTransportStart(kind)
  else handleTransportStop(kind)
}

function startCountdownTicker(): void {
  if (countdownTimer) return
  // 1 Hz display cadence — second changes are monotonic via countdownDisplaySeconds.
  countdownTimer = setInterval(() => {
    if (!countdownRunning) return
    publishCountdownIfSecondChanged()
  }, 1000)
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
    appVersion: formatViewerOneVersion(app.getVersion()),
    ledPattern,
    esp32Display,
    dmx: getDmxStatus(),
    queuedLedPattern: queuedRow ? clampLedPatternId(queuedRow.ledPattern) : null,
    ledMidiPulse,
    ledMidiPulseAt,
    prompt1On,
    prompt2On,
    promptMidiPulse,
    promptMidiPulseAt,
    arrangerScan,
    countdown: countdownSnapshot(),
    transport: {
      playing: transportPlaying,
      lastSource: lastTransportEvent?.source ?? null,
      lastAction: lastTransportEvent?.action ?? null,
      lastAtMs: lastTransportEvent?.at ?? null
    },
    lightingDirector: lightingDirector.snapshot(),
    lightingAnalyze,
    lightingReadiness: auditLightingReadiness(base.setlist),
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
      cubaseLastPcAgoMs: cubaseLastPcAtMs !== null ? Date.now() - cubaseLastPcAtMs : null,
      cubaseSpy,
      transportHint
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

/** Last JSON line pushed to the board — skip identical re-sends (same-song PC chase / mute echoes). */
let lastEsp32DisplayJson: string | null = null
/** Trailing coalesce — rapid Prev/Next/PC must not flood CrowPanel LVGL under 180° rotate. */
const ESP32_DISPLAY_COALESCE_MS = 80
let lastEsp32DisplayPushAt = 0
let esp32DisplayCoalesceTimer: ReturnType<typeof setTimeout> | null = null

function clearEsp32DisplayCoalesceTimer(): void {
  if (esp32DisplayCoalesceTimer) {
    clearTimeout(esp32DisplayCoalesceTimer)
    esp32DisplayCoalesceTimer = null
  }
}

/** Song title/year/duration/mute JSON only — does not change LEDs. Arms device countdown via r/p. */
function pushEsp32DisplayNow(): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  const snap = countdownSnapshot()
  const payload = buildEsp32DisplayPayload(
    st,
    snap.display,
    {
      remainingSeconds: snap.remainingSeconds,
      running: snap.running
    },
    { transportPlaying }
  )
  const json = JSON.stringify(payload)
  if (json === lastEsp32DisplayJson) return
  lastEsp32DisplayJson = json
  lastEsp32DisplayPushAt = Date.now()
  pushEsp32Payload(payload)
}

/**
 * Push display JSON to ESP. Rapid song flips coalesce (~80ms, latest wins) so the panel
 * never processes a full serial flood per arranger flick. Pass force on serial open.
 */
function broadcastEsp32DisplayIfEnabled(force = false): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  if (force) {
    clearEsp32DisplayCoalesceTimer()
    pushEsp32DisplayNow()
    return
  }
  const delay = Math.max(0, ESP32_DISPLAY_COALESCE_MS - (Date.now() - lastEsp32DisplayPushAt))
  clearEsp32DisplayCoalesceTimer()
  esp32DisplayCoalesceTimer = setTimeout(() => {
    esp32DisplayCoalesceTimer = null
    pushEsp32DisplayNow()
  }, delay)
}

/** Local HH:MM for CrowPanel right pad column — ESP has no reliable RTC. */
function formatLocalHm(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

let lastEsp32ClockHm: string | null = null
let esp32ClockTimer: ReturnType<typeof setTimeout> | null = null

function clearEsp32ClockTimer(): void {
  if (esp32ClockTimer) {
    clearTimeout(esp32ClockTimer)
    esp32ClockTimer = null
  }
}

/** Lightweight `{"hm":"HH:MM"}` — skip serial when minute string unchanged. */
function pushEsp32ClockIfChanged(force = false): void {
  const st = getState(store)
  if (!st.esp32Enabled) return
  const hm = formatLocalHm()
  if (!force && hm === lastEsp32ClockHm) return
  lastEsp32ClockHm = hm
  pushEsp32Clock(hm)
}

/** Send now, then again shortly after each minute boundary (~once/min). */
function scheduleEsp32ClockTicks(): void {
  clearEsp32ClockTimer()
  const now = new Date()
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 80
  esp32ClockTimer = setTimeout(() => {
    pushEsp32ClockIfChanged(true)
    scheduleEsp32ClockTicks()
  }, Math.max(250, msToNextMinute))
}

function startEsp32ClockSync(): void {
  lastEsp32ClockHm = null
  pushEsp32ClockIfChanged(true)
  scheduleEsp32ClockTicks()
}

function stopEsp32ClockSync(): void {
  clearEsp32ClockTimer()
  lastEsp32ClockHm = null
}

/** Push settings brightness unless between-song idle dim is active. */
function pushEsp32BrightnessFromSettings(): void {
  const st = getState(store)
  if (!st.esp32Enabled || ledIdleDimActive) return
  pushEsp32LedBrightness(st.ledBrightness)
}

function stopDmxRandomRotator(): void {
  if (!dmxRandomTimer) return
  clearInterval(dmxRandomTimer)
  dmxRandomTimer = null
}

function stopDmxStickAnimator(): void {
  if (!dmxStickTimer) return
  clearInterval(dmxStickTimer)
  dmxStickTimer = null
  dmxStickLastPattern = -1
}

function pushDmxFrame(): void {
  if (dmxLook === 'off' || ledPattern === 'blackout') {
    dmxBlackout()
    return
  }
  const idle = dmxLook === 'idle'
  const patternId = idle ? 0 : dmxLedPatternId
  if (patternId !== dmxStickLastPattern) {
    dmxStickLastPattern = patternId
    dmxStickT0 = Date.now()
  }
  const tMs = Date.now() - dmxStickT0
  if (idle) {
    dmxSetChannels(dmxUniverseForLook('idle', tMs * 0.55))
    return
  }
  dmxSetChannels(
    mergeDmxCueOverrides(
      dmxUniverseForLedPattern(patternId, tMs, dmxStickBrightnessScale, {
        stickPatternId: dmxCueOverride?.stickPatternId,
        domePatternId: dmxCueOverride?.domePatternId
      }),
      dmxCueOverride,
      getState(store).dmxFixture1Channel,
      getState(store).dmxFixture2Channel
    )
  )
}

function startDmxStickAnimator(): void {
  if (!dmxStickTimer) {
    dmxStickT0 = Date.now()
    dmxStickTimer = setInterval(() => pushDmxFrame(), DMX_STICK_FRAME_MS)
    dmxStickTimer.unref()
  }
  pushDmxFrame()
}

function startDmxRandomRotator(): void {
  stopDmxRandomRotator()
  dmxRandomChild = 1
  dmxLedPatternId = 1
  dmxRandomTimer = setInterval(() => {
    if (dmxLook !== 'live') return
    dmxRandomChild = dmxRandomChild >= 19 ? 1 : dmxRandomChild + 1
    dmxLedPatternId = dmxRandomChild
    refreshDmxOutput()
  }, DMX_RANDOM_ROTATE_MS)
  dmxRandomTimer.unref()
}

function armDmxForLedPattern(id: number): void {
  if (id === 99) {
    stopDmxRandomRotator()
    dmxLook = 'off'
    return
  }
  if (id === 0) {
    stopDmxRandomRotator()
    dmxLook = 'idle'
    return
  }
  dmxLook = 'live'
  if (id === 20) {
    startDmxRandomRotator()
    return
  }
  stopDmxRandomRotator()
  dmxLedPatternId = id
}

function refreshDmxOutput(): void {
  if (dmxLook === 'off' || ledPattern === 'blackout') {
    stopDmxStickAnimator()
    dmxBlackout()
    return
  }
  startDmxStickAnimator()
}

function syncDmxFromStore(): void {
  setDmxEnabled(true)
  refreshDmxOutput()
}

/**
 * Full LED blackout (pattern id 99). Same path as MIDI PC 125 / UI simulate / preview.
 * Clears idle dim and restores settings brightness (strip stays off via blackout pattern).
 */
function applyLedBlackout(): void {
  lightingDirector.disarm()
  noteLedMidiPulse(MIDI_PC_LED_BLACKOUT)
  const st = getState(store)
  ledIdleDimActive = false
  dmxLook = 'off'
  stopDmxRandomRotator()
  ledPattern = ledPatternName(99)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(99)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  refreshDmxOutput()
  broadcastUiState()
}

/**
 * Dim slow royal-blue knight rider (idle lights). Same path as MIDI PC 126 / UI simulate.
 * Display text is left as-is.
 */
function applyLedIdle(): void {
  lightingDirector.disarm()
  noteLedMidiPulse(MIDI_PC_LED_IDLE)
  ledIdleDimActive = true
  dmxLook = 'idle'
  stopDmxRandomRotator()
  ledPattern = 'knight_rider'
  const st = getState(store)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(0)
    pushEsp32LedBrightness(LED_IDLE_DIM_BRIGHTNESS)
  }
  refreshDmxOutput()
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
  const title = (row?.title ?? '').toUpperCase()

  if (
    st.lightingDirectorEnabled &&
    row &&
    !title.includes('SOUNDCHECK') &&
    row.lightingProgram?.cues?.length
  ) {
    armLightingDirectorForCurrentSong()
    broadcastUiState()
    return
  }

  lightingDirector.disarm()
  dmxCueOverride = undefined

  const id = row ? clampLedPatternId(row.ledPattern) : 0
  if (!row || id === 0 || title.includes('SOUNDCHECK')) {
    stopDmxRandomRotator()
    dmxLook = id === 99 ? 'off' : 'idle'
  } else {
    armDmxForLedPattern(id)
  }
  ledPattern = ledPatternName(id)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(id)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  refreshDmxOutput()
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
  armDmxForLedPattern(id)
  if (st.esp32Enabled) {
    pushEsp32LedPattern(id)
    pushEsp32LedBrightness(st.ledBrightness)
  }
  refreshDmxOutput()
  broadcastUiState()
}

/** Push current song/mute JSON only — board keeps its own LED state until PC 125/126/127. */
function onEsp32SerialOpened(): void {
  lastEsp32DisplayJson = null
  lastEsp32DisplayPushAt = 0
  pushEsp32HelloRequest()
  broadcastEsp32DisplayIfEnabled(true)
  startEsp32ClockSync()
  const st = getState(store)
  if (st.esp32Enabled) {
    pushEsp32Prompt(1, prompt1On)
    pushEsp32Prompt(2, prompt2On)
  }
}

/**
 * Sends mute state to Cubase (ch1 CC88/85/86/87). Mixer bridge is separate via
 * {@link sendMuteCcToMixer} — Cubase no longer needs a parallel "X32 Mutes" → X-USB track.
 */
function sendMuteCcToCubase(muted: boolean, controller = CUBASE_MUTE_CC): void {
  const now = Date.now()
  // FX CC85 / ALL CC88: muted→0; Synth/Piano CC86/87: inverted muted→127 (Jump/Value).
  const value = cubaseMuteCcValue(muted, controller)
  cubaseLastSentAtMs = now
  cubaseLastSentCc = { channel: CUBASE_MUTE_CHANNEL - 1, controller, value }
  muteSentBySourceCc.set(muteEchoKey('cubase', controller), { value, atMs: now })
  console.log(
    `[ViewerOne] MIDI: sending mute=${muted} to Cubase (ch ${CUBASE_MUTE_CHANNEL}, CC ${controller}, val ${value}) on "${cubaseOutputName ?? '(no output port)'}"`
  )
  midi.sendControlChange(CUBASE_MUTE_CHANNEL, controller, value)
}

/** True when this Cubase CC is our own echo — keyed by source+CC only (never bare CC / global window). */
function isOwnCubaseMuteEcho(controller: number, value: number): boolean {
  const now = Date.now()
  const last = muteSentBySourceCc.get(muteEchoKey('cubase', controller))
  if (!last) return false
  if (now - last.atMs < MUTE_ECHO_IGNORE_MS) return true
  // Same absolute value we last sent — ignore late duplicate feedback.
  if (last.value === value && now - last.atMs < MUTE_ECHO_IGNORE_MS * 3) return true
  return false
}

/**
 * Sends mute directly to the mixer's USB MIDI port (mute groups: 0 = muted/active).
 * Controller comes from {@link BRIDGED_MUTES} (FX=MG6/CC85, ALL=MG1/CC80). Same absolute pattern.
 */
function sendMuteCcToMixer(
  muted: boolean,
  controller: number,
  group: BridgedMuteId | 'boot'
): void {
  const now = Date.now()
  const value = mixerMuteCcValue(muted)
  muteSentBySourceCc.set(muteEchoKey('mixer', controller), { value, atMs: now })
  mixerLastSentAtMs = now
  mixerLastSentCc = { channel: MIXER_MUTE_CHANNEL - 1, controller, value }
  console.log(
    `[ViewerOne] MIDI: mixer TX group=${group} CC=${controller} val=${value} muted=${muted} ` +
      `ch=${MIXER_MUTE_CHANNEL} port="${mixerOutputName ?? '(no output port)'}"`
  )
  midi.sendMixerControlChange(MIXER_MUTE_CHANNEL, controller, value)
}

/** Mixer echo ignore — keyed by source+CC (`mixer:80` ≠ `cubase:88`). */
function isOwnMixerMuteEcho(controller: number, value: number): boolean {
  const now = Date.now()
  const last = muteSentBySourceCc.get(muteEchoKey('mixer', controller))
  if (!last) return false
  if (now - last.atMs < MUTE_ECHO_IGNORE_MS) return true
  if (last.value === value && now - last.atMs < MUTE_ECHO_IGNORE_MS * 3) return true
  return false
}

/**
 * Single Cubase ↔ ViewerOne ↔ mixer mute apply for FX and ALL.
 * Absolute SET. Always emit absolute CCs when opts request TX (same as pre-bridge FX —
 * re-asserts mixer/Cubase if store drifted). Only {@link BridgedMuteDef} CCs/state differ.
 */
function applyBridgedMute(
  def: BridgedMuteDef,
  muted: boolean,
  opts: { sendToCubase: boolean; sendToMixer: boolean }
): void {
  const st = getState(store)
  const prev = Boolean(st[def.stateKey])
  const changed = prev !== muted
  if (changed) {
    setState(store, { [def.stateKey]: muted })
  } else {
    console.log(
      `[ViewerOne] MIDI: bridged ${def.id} state already muted=${muted} ` +
        `(still TX absolute if flagged) cubaseCC=${def.cubaseCc} mixerCC=${def.mixerCc}`
    )
  }
  if (opts.sendToCubase) sendMuteCcToCubase(muted, def.cubaseCc)
  if (opts.sendToMixer) sendMuteCcToMixer(muted, def.mixerCc, def.id)
  console.log(
    `[ViewerOne] MIDI: bridged ${def.id} origin-flags cubase=${opts.sendToCubase} mixer=${opts.sendToMixer} ` +
      `prev=${prev} next=${muted} changed=${changed} cubaseCC=${def.cubaseCc} mixerCC=${def.mixerCc}`
  )
  // Mute updates display tint + CC only — LEDs stay on PC 125/126/127 (and pattern preview).
  if (changed) broadcastState()
}

/** CrowPanel / CYD mute pad — absolute `muted` when provided, else host toggle (legacy CYD FX). */
function applyBridgedMuteFromEsp(def: BridgedMuteDef, mutedRaw: unknown): void {
  const st = getState(store)
  const muted = typeof mutedRaw === 'boolean' ? mutedRaw : !Boolean(st[def.stateKey])
  console.log(
    `[ViewerOne] MIDI: ${def.id} mute from ESP raw=${JSON.stringify(mutedRaw)} → absolute muted=${muted}`
  )
  applyBridgedMute(def, muted, { sendToCubase: true, sendToMixer: true })
}

function applyChannelMuted(
  which: 'synth' | 'piano',
  muted: boolean,
  opts: { sendToCubase: boolean; source?: string }
): void {
  const st = getState(store)
  const key = which === 'synth' ? 'synthMuted' : 'pianoMuted'
  const prev = Boolean(st[key])
  const changed = prev !== muted
  const cc = which === 'synth' ? CUBASE_SYNTH_MUTE_CC : CUBASE_PIANO_MUTE_CC
  const value = cubaseMuteCcValue(muted, cc)
  const source = opts.source ?? 'host'
  console.log(
    `[ViewerOne] MIDI: ${which} mute press source=${source} prev=${prev} → next=${muted} ` +
      `changed=${changed} CC=${cc} val=${value} send=${opts.sendToCubase}`
  )
  if (changed) setState(store, { [key]: muted })
  // Absolute CC; Synth/Piano polarity inverted vs FX (see cubaseMuteCcValue).
  if (opts.sendToCubase) {
    sendMuteCcToCubase(muted, cc)
    console.log(
      `[ViewerOne] MIDI: ${which} mute CC sent (one absolute) muted=${muted} CC=${cc} val=${value}`
    )
  } else {
    console.log(`[ViewerOne] MIDI: ${which} mute UI-only (no CC out) muted=${muted}`)
  }
  if (changed) broadcastState()
}

/**
 * CrowPanel synth/piano pads send absolute `muted` after their local flip.
 * Host SETs that value once and sends one CC — never toggle on top of the device flip.
 */
function applyChannelMutedFromEsp(which: 'synth' | 'piano', mutedRaw: unknown): void {
  const st = getState(store)
  const muted =
    typeof mutedRaw === 'boolean'
      ? mutedRaw
      : which === 'synth'
        ? !st.synthMuted
        : !st.pianoMuted
  console.log(
    `[ViewerOne] MIDI: ${which} mute from ESP raw=${JSON.stringify(mutedRaw)} → absolute muted=${muted}`
  )
  applyChannelMuted(which, muted, { sendToCubase: true, source: 'esp' })
}

/**
 * After Cubase out opens: push absolute mute CCs matching UI (bridged FX/ALL + inverted Synth/Piano).
 * Do NOT send an opposite edge — with Generic Remote Toggle flags that yields an odd
 * toggle count and permanently inverts Cubase vs pads (two-click / every-other symptom).
 */
function syncMutesToCubaseOnConnect(): void {
  if (muteBootSyncTimer) {
    clearTimeout(muteBootSyncTimer)
    muteBootSyncTimer = null
  }
  if (muteBootSyncFollowUpTimer) {
    clearTimeout(muteBootSyncFollowUpTimer)
    muteBootSyncFollowUpTimer = null
  }
  if (!cubaseOutputOpen) return

  const st = getState(store)
  const targets: { label: string; muted: boolean; cc: number }[] = [
    ...BRIDGED_MUTES.map((b) => ({
      label: b.id,
      muted: Boolean(st[b.stateKey]),
      cc: b.cubaseCc
    })),
    { label: 'synth', muted: st.synthMuted, cc: CUBASE_SYNTH_MUTE_CC },
    { label: 'piano', muted: st.pianoMuted, cc: CUBASE_PIANO_MUTE_CC }
  ]
  console.log(
    `[ViewerOne] MIDI: boot-sync mutes (absolute only) → Cubase ` +
      BRIDGED_MUTES.map((b) => `${b.id}=${st[b.stateKey]}`).join(' ') +
      ` synth=${st.synthMuted} piano=${st.pianoMuted}`
  )
  for (const t of targets) {
    sendMuteCcToCubase(t.muted, t.cc)
  }
  // One identical settle for all channels (even count if remote is Toggle; Value ignores dup).
  muteBootSyncTimer = setTimeout(() => {
    muteBootSyncTimer = null
    for (const t of targets) {
      sendMuteCcToCubase(t.muted, t.cc)
    }
  }, 45)
}

/**
 * After mixer out opens: push absolute FX/ALL mute CCs matching UI.
 * Required when Cubase is closed — otherwise store and X32 can disagree and the first
 * VO press looks like a no-op (TX of the value the mixer already has).
 */
function syncMutesToMixerOnConnect(): void {
  if (!mixerOutputOpen) return
  const st = getState(store)
  console.log(
    `[ViewerOne] MIDI: boot-sync mutes (absolute only) → mixer ` +
      BRIDGED_MUTES.map((b) => `${b.id}=${st[b.stateKey]}→CC${b.mixerCc}`).join(' ')
  )
  for (const b of BRIDGED_MUTES) {
    sendMuteCcToMixer(Boolean(st[b.stateKey]), b.mixerCc, 'boot')
  }
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
    // CrowPanel groups: bridged FX/ALL share one path; Synth/Piano stay separate.
    const group = typeof msg['group'] === 'string' ? msg['group'].toLowerCase() : ''
    const bridged = bridgedMuteByEspGroup(group)
    if (bridged) {
      applyBridgedMuteFromEsp(bridged, msg['muted'])
    } else if (group === 'synth') {
      applyChannelMutedFromEsp('synth', msg['muted'])
    } else if (group === 'piano') {
      applyChannelMutedFromEsp('piano', msg['muted'])
    } else {
      console.log(`[ViewerOne] ESP32 mute_toggle ignored for group=${group}`)
    }
  }
  if (evt === 'boot') {
    applyLedPatternFromEsp(msg['led'])
    // Board reset — resend display JSON only; strip keeps firmware boot KR until PC 125/126/127.
    console.log('[ViewerOne] ESP32 reported boot/reset — resending display state')
    lastEsp32DisplayJson = null
    broadcastEsp32DisplayIfEnabled()
    startEsp32ClockSync()
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
    height: null,
    fw: null
  }
  if (st.esp32Enabled) {
    setEsp32SerialPort(ESP32_SERIAL_PORT_AUTO, () => onEsp32SerialOpened())
  } else {
    clearEsp32DisplayCoalesceTimer()
    lastEsp32DisplayJson = null
    stopEsp32ClockSync()
    setEsp32SerialPort(null)
  }
}

function broadcastUiState(): void {
  const payload = buildPublicState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('state:update', payload)
  }
}

function broadcastLoopbackMeter(sample: LoopbackMeterSample): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send('lighting:loopbackMeter', sample)
  }
}

function broadcastState(): void {
  broadcastUiState()
  broadcastEsp32DisplayIfEnabled()
}

/**
 * Connects Cubase (loopMIDI: song/transport + mute CCs) and the mixer (X-USB mute bridge).
 * Cubase FX (CC85) ↔ mixer mute group 6 (ch2/CC85); Cubase ALL (CC88) ↔ mixer mute group 1 (ch2/CC80).
 * Port names are auto-detected — see shared/midiAutoDetect.ts; CC conventions in midiConfig.ts.
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
  cubaseSpy = []
  // Keep transportHint / realtimeTransportSeen across reconnect so auto-detect stays visible.
  midi.setProgramChangeChannel(CUBASE_PC_CHANNEL)
  const transportMap = getState(store).transportMidi
  console.log(
    `[ViewerOne] MIDI: transport map mode=${transportMap.mode} ch=${transportMap.channel || 'any'} ` +
      `start=${transportMap.startNumber} stop=${transportMap.stopNumber} (+ realtime + MMC)`
  )
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
      if (lightingAnalyze.active) {
        latestSongProgram = wireProgram + 1
        songIdentityRevision++
        console.log(`[ViewerOne] Lighting analyze: song PC ${latestSongProgram} ch ${channel0 + 1}`)
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
        // New song → full length. Same-song PC echo must NOT reset a frozen pause remaining
        // (Cubase often re-chases the song PC around Stop — that was wiping the countdown).
        if (!sameSongRefired) {
          const wasPlaying = transportPlaying || countdownRunning
          if (wasPlaying && countdownSongId != null && countdownTotalSeconds > 0) {
            const leftover = countdownRemainingNowMs()
            // Snap ending song to 0 at the arranger boundary (push once before arming next).
            countdownRemainingMs = 0
            countdownAnchorRemainingMs = 0
            countdownClockBiasMs = 0
            countdownRunning = false
            countdownStartedAtMs = null
            countdownLastPublishedSecond = 0
            broadcastState()
            // Conservative auto-cal: leftover at block end ≈ Cubase Start lag to absorb next time.
            if (leftover >= 500 && leftover <= 10000) {
              const prev = clampCountdownStartLeadMs(getState(store).countdownStartLeadMs)
              const blended = clampCountdownStartLeadMs(Math.round(prev * 0.35 + leftover * 0.65))
              if (blended !== prev) {
                setState(store, { countdownStartLeadMs: blended })
                console.log(
                  `[ViewerOne] countdown start lead auto-calibrated: ${prev} → ${blended}ms (boundary leftover ${Math.round(leftover)}ms)`
                )
              }
            }
          }
          setState(store, { currentSongId: row.id })
          resetCountdownForSong(row.id, false)
          if (wasPlaying) {
            // Already rolling into the next arranger block — arm with Start-lead compensation.
            beginCountdownRunning(Date.now(), { applyLead: true })
          }
        } else {
          setState(store, { currentSongId: row.id })
          countdownSongId = row.id
        }
        broadcastState()
      } else {
        console.log(`[ViewerOne] MIDI: song PC ${pc} — no setlist row (ch ${channel0 + 1})`)
      }
    },
    onControlChange: (msg) => {
      tryMappedTransport('cc', msg.channel, msg.controller, msg.value)
      if (msg.channel !== cubaseMuteCh0) return
      if (isOwnCubaseMuteEcho(msg.controller, msg.value)) {
        console.log(
          `[ViewerOne] MIDI: ignoring Cubase mute echo (ch ${msg.channel + 1} CC ${msg.controller}=${msg.value})`
        )
        return
      }
      // Cubase mute → ViewerOne UI/ESP + forward to X32. Never sendToCubase (would loop Generic Remote).
      const bridged = bridgedMuteByCubaseCc(msg.controller)
      if (bridged) {
        const muted = ccValueToMuted(msg.value)
        console.log(
          `[ViewerOne] MIDI: Cubase ${bridged.id}/CC${bridged.cubaseCc}=${msg.value} → muted=${muted} (forward mixer)`
        )
        applyBridgedMute(bridged, muted, { sendToCubase: false, sendToMixer: true })
        return
      }
      if (msg.controller === CUBASE_SYNTH_MUTE_CC) {
        // Inverted Jump/Value: 127=muted, 0=live (opposite of FX CC85).
        applyChannelMuted('synth', ccValueToMuted(msg.value, CUBASE_CHANNEL_MUTE_INVERTED), {
          sendToCubase: false,
          source: 'cubase'
        })
        return
      }
      if (msg.controller === CUBASE_PIANO_MUTE_CC) {
        applyChannelMuted('piano', ccValueToMuted(msg.value, CUBASE_CHANNEL_MUTE_INVERTED), {
          sendToCubase: false,
          source: 'cubase'
        })
      }
    },
    onNoteOn: (msg) => {
      tryMappedTransport('note', msg.channel, msg.note, msg.velocity)
    },
    onNoteOff: (msg) => {
      // Some Generic Remote maps fire Stop as note-off of the Stop note.
      const mapping = getState(store).transportMidi
      if (mapping.mode !== 'note') return
      if (msg.note === mapping.stopNumber) {
        tryMappedTransport('note', msg.channel, msg.note, 1)
      }
    },
    onSystemRealtimeStart: () => handleTransportStart('realtime'),
    onSystemRealtimeContinue: () => handleTransportContinue('realtime'),
    onSystemRealtimeStop: () => handleTransportStop('realtime'),
    onSystemRealtimeClock: () => handleMidiClockTick(),
    onSongPosition: (midiBeats) => handleSongPosition(midiBeats),
    onSysexBytes: (bytes) => {
      const command = parseMmcTransportCommand(bytes)
      // MMC Play from Stop resumes (freeze-aware). MMC Play while rolling uses Start rules.
      if (command === 'play') {
        if (transportPlaying || countdownRunning) handleTransportStart('MMC')
        else handleTransportContinue('MMC')
      } else if (command === 'stop') handleTransportStop('MMC')
    },
    onSpyEvent: (event) => pushCubaseSpy(event),
    getSpyContext: () => ({ transportMidi: getState(store).transportMidi })
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
    // UI MIDI status only — do not spam full song JSON to CrowPanel on every mixer CC.
    broadcastUiState()
    if (msg.channel !== mixerMuteCh0 || !isMixerMuteCc(msg.controller)) {
      // Still surface other mixer CCs in Live status (mixerLastCc); only bridged mutes drive state.
      return
    }
    if (isOwnMixerMuteEcho(msg.controller, msg.value)) {
      console.log(
        `[ViewerOne] MIDI: ignoring mixer mute echo (ch ${msg.channel + 1} CC ${msg.controller}=${msg.value})`
      )
      return
    }
    const bridged = bridgedMuteByMixerCc(msg.controller)
    if (!bridged) return
    // Mute-group polarity (MG6/MG1): 0=active/muted — opposite of bus/channel 127=muted.
    const muted = ccValueToMixerMuted(msg.value)
    console.log(
      `[ViewerOne] MIDI: mixer RX group=${bridged.id} CC=${msg.controller} val=${msg.value} muted=${muted} (forward Cubase, no mixer echo)`
    )
    applyBridgedMute(bridged, muted, { sendToCubase: true, sendToMixer: false })
  })
  mixerOutputOpen = midi.openMixerOutput(mixer.output)

  console.log(
    `[ViewerOne] MIDI: connected — Cubase in=${cubaseInputName ?? '—'}(${cubaseInputOpen ? 'open' : 'closed'}) ` +
      `out=${cubaseOutputName ?? '—'}(${cubaseOutputOpen ? 'open' : 'closed'}); ` +
      `Mixer in=${mixerInputName ?? '—'}(${mixerInputOpen ? 'open' : 'closed'}) ` +
      `out=${mixerOutputName ?? '—'}(${mixerOutputOpen ? 'open' : 'closed'})`
  )
  if (mixerInputOpen && mixerOutputOpen) {
    console.log(
      `[ViewerOne] MIDI: mute bridges armed — ` +
        BRIDGED_MUTES.map(
          (b) =>
            `${b.id} Cubase CC${b.cubaseCc} ↔ mixer ch${MIXER_MUTE_CHANNEL}/CC${b.mixerCc}`
        ).join('; ')
    )
  } else if (!mixerInputOpen && mixerInputName) {
    console.warn(
      `[ViewerOne] MIDI: mixer input "${mixerInputName}" did not open — mixer→ViewerOne mute will not work (Cubase exclusive X-USB IN?)`
    )
  } else if (!mixerOutputOpen && mixerOutputName) {
    console.warn(
      `[ViewerOne] MIDI: mixer output "${mixerOutputName}" did not open — ViewerOne/Cubase→mixer mute will not work (port in use?)`
    )
  }
  // Mixer path must work with Cubase closed — sync absolute FX/ALL to X32 whenever out is open.
  if (mixerOutputOpen) syncMutesToMixerOnConnect()
  if (cubaseOutputOpen) syncMutesToCubaseOnConnect()
}

function disconnectMidi(): void {
  if (muteBootSyncTimer) {
    clearTimeout(muteBootSyncTimer)
    muteBootSyncTimer = null
  }
  if (muteBootSyncFollowUpTimer) {
    clearTimeout(muteBootSyncFollowUpTimer)
    muteBootSyncFollowUpTimer = null
  }
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

/** Best-effort Cubase Stop via configured transport mapping (never Start / never Arranger notes). */
function sendCubaseTransportStop(reason: string): void {
  if (!cubaseOutputOpen) return
  const mapping = getState(store).transportMidi
  console.warn(
    `[ViewerOne] MIDI: sending transport Stop (${mapping.mode} ${mapping.stopNumber} ch ${mapping.channel || 'any'}) — ${reason}`
  )
  const ch = mapping.channel >= 1 && mapping.channel <= 16 ? mapping.channel : 16
  if (mapping.mode === 'note') midi.sendNotePulse(ch, mapping.stopNumber, 127, 60)
  else midi.sendControlChange(ch, mapping.stopNumber, 127)
}

/** After an Arranger inspector click: if Cubase looks like it started playing, Stop and abort further clicks. */
async function stopIfTransportStartedAfterClick(label: string): Promise<boolean> {
  await sleep(350)
  if (!transportPlaying) return false
  sendCubaseTransportStop(`transport started after click (${label})`)
  await sleep(200)
  return true
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
  midi.flushPendingNoteOffs()
  // Cubase may still be draining queued Previous notes — wait until song PCs go quiet.
  await waitForSongIdentityQuiet(500, 6000, respectCancel)
  return !(respectCancel && arrangerScanCancelled)
}

/** Wait until Cubase stops sending song Program Changes (delayed click/chase PCs). */
async function waitForSongIdentityQuiet(
  quietMs: number,
  maxMs: number,
  respectCancel: boolean
): Promise<void> {
  const started = Date.now()
  let lastRev = songIdentityRevision
  let quietSince = Date.now()
  while (Date.now() - started < maxMs) {
    if (respectCancel && arrangerScanCancelled) return
    await sleep(40)
    if (songIdentityRevision !== lastRev) {
      lastRev = songIdentityRevision
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs) {
      return
    }
  }
}

/**
 * Wait until Cubase reports a *different* song PC than `fromProgram`.
 * Cubase often re-chases the current song PC when Arranger Next/Prev is pressed; that bumps
 * `songIdentityRevision` without leaving the song. Treating that as a step caused false
 * "already seen earlier" stops (and left later songs unvisited).
 */
async function waitForSongIdentityChange(
  fromProgram: number,
  revisionAtSend: number,
  respectCancel: boolean
): Promise<number | null> {
  const deadline = Date.now() + ARRANGER_CHANGE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (respectCancel && arrangerScanCancelled) return null
    if (
      songIdentityRevision > revisionAtSend &&
      latestSongProgram !== null &&
      latestSongProgram !== fromProgram
    ) {
      return latestSongProgram
    }
    await sleep(ARRANGER_IDENTITY_POLL_MS)
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
      // before issuing another Next/Prev command. Prefer the post-settle identity in case a
      // chase + real change landed in the same window.
      if (!(await waitForArrangerSettle(respectCancel))) return null
      if (latestSongProgram !== null && latestSongProgram !== fromProgram) {
        return latestSongProgram
      }
      return changed
    }
    if (respectCancel && arrangerScanCancelled) return null
    console.log(
      `[ViewerOne] Arranger scan: ${direction} produced no song change (${attempt}/${ARRANGER_NO_CHANGE_ATTEMPTS})`
    )
  }
  return null
}

async function restoreArrangerToProgram(
  want: number,
  respectCancel: boolean,
  walkOrder: number[] = []
): Promise<boolean> {
  if (latestSongProgram === want) return true
  const wanti = walkOrder.indexOf(want)
  const curi = latestSongProgram != null ? walkOrder.indexOf(latestSongProgram) : -1
  // Clicks usually jump earlier in the chain (INTRO / leftover). Prefer Next toward the walk song.
  let dirs: Array<'prev' | 'next'> =
    curi >= 0 && wanti >= 0 && curi > wanti ? ['prev', 'next'] : ['next', 'prev']
  for (const dir of dirs) {
    for (let i = 0; i < 8; i++) {
      if (respectCancel && arrangerScanCancelled) return false
      if (latestSongProgram === want) return true
      const from = latestSongProgram ?? want
      const stepped = await stepArrangerUntilChanged(dir, from, respectCancel)
      if (stepped === want) return true
      if (stepped === null) break
    }
  }
  return latestSongProgram === want
}

function buildScannedSetlist(
  programs: number[],
  previous: SetlistItem[],
  lengthOverrides?: Map<number, string>
): SetlistItem[] {
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
    // Only apply OCR lengths that actually parsed — never blank prior lengths with '' / 00:00.
    const ocrLength = lengthOverrides?.has(program)
      ? normalizeSongLength(lengthOverrides.get(program))
      : ''
    const priorRaw = old?.length || ''
    const prior = isKeepableLengthForTitle(priorRaw, old?.title || '') ? priorRaw : ''
    return {
      id,
      program,
      arrangerIndex: index + 1,
      title: old?.title || `Song PC ${program}`,
      length: ocrLength || prior || '',
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

/** Status-bar length like `3:39` (strip leading zero minutes). */
function statusLengthLabel(mmss: string): string {
  const n = normalizeSongLength(mmss)
  if (!n) return mmss
  const [m, s] = n.split(':')
  return `${Number(m)}:${s}`
}

/**
 * Arranger scan — one MIDI walk with inline length grab.
 * After each song PC, locate the named Arranger event (chain-row play triangle
 * if the block is off-screen) and read Info Line Length. Never skip a visited
 * song that has no keepable length — retry, then a repair pass, then mark the
 * scan incomplete.
 */
async function runArrangerScan(): Promise<void> {
  // Recover a stuck flag if a prior run died without clearing the in-flight promise.
  if (arrangerScan.active && !arrangerScanPromise) {
    console.warn('[ViewerOne] Arranger scan: clearing stuck active flag before new scan')
    arrangerScan = {
      active: false,
      phase: 'idle',
      collected: 0,
      message: 'Ready'
    }
  }
  if (arrangerScanPromise || arrangerScan.active) {
    console.log('[ViewerOne] Arranger scan: ignored — already in progress')
    return
  }

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

  arrangerScanPromise = (async () => {
    arrangerScanCancelled = false
    midi.flushPendingNoteOffs()
    setArrangerScan({
      active: true,
      phase: 'scanning',
      collected: 0,
      message: `Rewinding to the first Arranger event (${ARRANGER_REWIND_PULSES} fast Previous pulses)…`
    })

    try {
      const pcBeforeRewind = latestSongProgram
      const revBeforeRewind = songIdentityRevision
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
      let startProgram = latestSongProgram ?? currentRow?.program ?? null
      const rewindSentPc = songIdentityRevision > revBeforeRewind
      if (
        !rewindSentPc &&
        pcBeforeRewind != null &&
        startProgram === pcBeforeRewind &&
        !arrangerScanCancelled
      ) {
        console.warn(
          `[ViewerOne] Arranger scan: rewind sent no Program Change (still PC ${startProgram}) — probing Next for the real first event`
        )
        setArrangerScan({
          collected: 0,
          message: `Rewind sent no song PC (still PC ${startProgram}) — stepping Next to find the first event…`
        })
        const probed = await stepArrangerUntilChanged('next', startProgram, true)
        if (probed != null) {
          startProgram = probed
        }
      }
      if (startProgram === null || startProgram < 1 || startProgram > MIDI_PC_SONG_MAX) {
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            'Reached the beginning, but received no song Program Change from Cubase. Previous setlist kept.'
        })
        return
      }

      setArrangerScan({
        message: 'Expanding Cubase Arranger Track for length OCR…'
      })
      try {
        await expandCubaseArrangerLayout()
      } catch (expandErr) {
        console.warn(
          `[ViewerOne] Arranger scan: expand skipped — ${
            expandErr instanceof Error ? expandErr.message : String(expandErr)
          }`
        )
      }

      const programs = [startProgram]
      const seenPrograms = new Set(programs)
      let currentProgram = startProgram
      let stopReason: string | null = null
      const lengthByProgram = new Map<number, string>()
      let lengthsOk = 0
      let lengthsFailed = 0
      let lengthPassRan = false
      let lengthPassSkippedReason: string | null = null

      const titleForProgram = (program: number): string => {
        const st = getState(store)
        const row =
          st.setlist.find((r) => r.program === program && r.arrangerIndex != null) ??
          st.setlist.find((r) => r.program === program) ??
          before.setlist.find((r) => r.program === program && r.arrangerIndex != null) ??
          before.setlist.find((r) => r.program === program)
        return (row?.title || '').trim() || `Song PC ${program}`
      }

      const publishProgressSetlist = (): void => {
        const scanned = buildScannedSetlist(programs, before.setlist, lengthByProgram)
        setState(store, { setlist: scanned })
        lastEsp32DisplayJson = null
        broadcastState()
      }

      const captureLengthForProgram = async (program: number, songIndex: number): Promise<void> => {
        if (!CUBASE_AUTO_LENGTH_PASS || arrangerScanCancelled) return
        const title = titleForProgram(program)
        const previousLength = isKeepableLengthForTitle(
          before.setlist.find((r) => r.program === program)?.length || lengthByProgram.get(program) || '',
          title
        )
          ? before.setlist.find((r) => r.program === program)?.length || lengthByProgram.get(program) || ''
          : ''
        if (latestSongProgram !== null && latestSongProgram !== program) {
          console.warn(
            `[ViewerOne] Arranger scan: length grab for “${title}” is on PC ${latestSongProgram}, restoring walk PC ${program} first`
          )
          await restoreArrangerToProgram(program, true, programs)
        }
        setArrangerScan({
          collected: programs.length,
          message: `Song ${songIndex} “${title}”: reading length from Cubase…`
        })
        try {
          const isUsableRead = (r: { ok: boolean; nameMatched: boolean; mmss: string }) =>
            Boolean(r.ok && r.nameMatched && r.mmss && isKeepableLengthForTitle(r.mmss, title))
          const wasMin =
            Boolean(controlWindow) &&
            !controlWindow!.isDestroyed() &&
            controlWindow!.isMinimized()
          if (controlWindow && !controlWindow.isDestroyed() && !wasMin) {
            controlWindow.minimize()
            await sleep(120)
          }
          let read: Awaited<ReturnType<typeof readCubaseLengthForEvent>>
          try {
            read = await readCubaseLengthForEvent(title, { allowClick: true })
            for (
              let attempt = 2;
              attempt <= ARRANGER_LENGTH_ATTEMPTS && !isUsableRead(read) && !arrangerScanCancelled;
              attempt++
            ) {
              await sleep(ARRANGER_LENGTH_RETRY_GAP_MS)
              const retry = await readCubaseLengthForEvent(title, { allowClick: true })
              if (isUsableRead(retry)) {
                console.log(
                  `[ViewerOne] Arranger scan: length retry ${attempt} succeeded PC ${program} “${title}” → ${retry.mmss}`
                )
                read = retry
                break
              }
              read = retry
            }
          } finally {
            if (controlWindow && !controlWindow.isDestroyed() && !wasMin) {
              controlWindow.restore()
            }
          }
          if (transportPlaying) {
            sendCubaseTransportStop(`Cubase was already playing during length OCR (${title})`)
            await sleep(120)
          }
          if (arrangerScanCancelled) return
          if (isUsableRead(read) && read.mmss) {
            lengthByProgram.set(program, normalizeSongLength(read.mmss))
            lengthsOk++
            lengthPassRan = true
            publishProgressSetlist()
            setArrangerScan({
              collected: programs.length,
              message: `Song ${songIndex} “${title}”: ${statusLengthLabel(read.mmss)} from Cubase`
            })
            console.log(
              `[ViewerOne] Arranger scan: length PC ${program} “${title}” → ${read.mmss} (${read.source})`
            )
          } else {
            const tooLong =
              Boolean(read.mmss) && !isKeepableLengthForTitle(read.mmss, title)
                ? `rejected ${statusLengthLabel(read.mmss)} (too long for this song — likely missed Arranger event)`
                : ''
            lengthsFailed += isSoundcheckTitle(title) ? 0 : 1
            lengthPassRan = true
            setArrangerScan({
              collected: programs.length,
              message:
                `Song ${songIndex} “${title}”: length not read` +
                (previousLength ? ` (kept ${statusLengthLabel(previousLength)})` : '') +
                (tooLong ? ` — ${tooLong}` : read.error ? ` — ${read.error}` : '')
            })
            console.warn(
              `[ViewerOne] Arranger scan: length PC ${program} “${title}” failed — ${
                tooLong || read.error || 'unreadable'
              }`
            )
          }
        } catch (err) {
          if (!isSoundcheckTitle(title)) lengthsFailed++
          console.warn(
            `[ViewerOne] Arranger scan: length PC ${program} error — ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
        if (latestSongProgram !== null && latestSongProgram !== program) {
          console.warn(
            `[ViewerOne] Arranger scan: length click left PC ${latestSongProgram}, restoring walk PC ${program}`
          )
          await restoreArrangerToProgram(program, true, programs)
        }
        await waitForSongIdentityQuiet(450, 1200, true)
      }

      // Single walk: order + length together (no second MIDI rewind/walk).
      console.log(
        `[ViewerOne] Arranger scan: starting at PC ${startProgram} (inline length grab)`
      )
      setArrangerScan({
        active: true,
        phase: 'scanning',
        collected: 1,
        message: `Song 1 “${titleForProgram(startProgram)}”… PC ${startProgram}`
      })
      publishProgressSetlist()
      await captureLengthForProgram(startProgram, 1)

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
          const titleBit = title ? ` (${title})` : ''
          // Stale start: rewind landed on an event that sends no PC, so we seeded
          // the walk with the leftover song. Next then wraps to that leftover after INTRO.
          // Drop the stale first PC and keep walking.
          if (currentProgram === startProgram && programs.length <= 3) {
            console.warn(
              `[ViewerOne] Arranger scan: wrap to start PC ${currentProgram} after only ${programs.length} song(s) — treating start as stale, continuing`
            )
            seenPrograms.delete(startProgram)
            if (programs[0] === startProgram) programs.shift()
            startProgram = programs[0] ?? currentProgram
            if (!seenPrograms.has(currentProgram)) {
              programs.push(currentProgram)
              seenPrograms.add(currentProgram)
              setArrangerScan({
                collected: programs.length,
                message: `Song ${programs.length} “${titleForProgram(currentProgram)}”… PC ${currentProgram}`
              })
              publishProgressSetlist()
              await captureLengthForProgram(currentProgram, programs.length)
            }
            continue
          }
          if (currentProgram === startProgram) {
            stopReason =
              `Scan stopped: Arranger returned to starting song PC ${currentProgram}${titleBit} — ` +
              'end of chain (or circular Arranger)'
          } else {
            stopReason =
              `Scan stopped: song PC ${currentProgram}${titleBit} already seen earlier — ` +
              'possible duplicate Program Change in Cubase arranger'
          }
          console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
          break
        }
        programs.push(currentProgram)
        seenPrograms.add(currentProgram)
        setArrangerScan({
          collected: programs.length,
          message: `Song ${programs.length} “${titleForProgram(currentProgram)}”… PC ${currentProgram}`
        })
        publishProgressSetlist()
        await captureLengthForProgram(currentProgram, programs.length)
      }
      if (!arrangerScanCancelled && programs.length >= MIDI_PC_SONG_MAX && !stopReason) {
        stopReason = `Scan stopped: safety limit of ${MIDI_PC_SONG_MAX} unique song PCs reached`
        console.warn(`[ViewerOne] Arranger scan: ${stopReason}`)
      }

      console.log(
        `[ViewerOne] Arranger scan: walk ended — ${programs.length} song(s), lengths ${lengthsOk} ok / ${lengthsFailed} missed` +
          (stopReason ? ` (${stopReason})` : '')
      )

      const missingAfterWalk = programs.filter((program) => {
        const title = titleForProgram(program)
        const have =
          lengthByProgram.get(program) ||
          before.setlist.find((r) => r.program === program)?.length ||
          ''
        return !isKeepableLengthForTitle(have, title)
      })
      if (!arrangerScanCancelled && missingAfterWalk.length > 0) {
        console.warn(
          `[ViewerOne] Arranger scan: ${missingAfterWalk.length} song(s) still missing a Cubase length — repair pass (will not skip)`
        )
        for (const program of missingAfterWalk) {
          if (arrangerScanCancelled) break
          const title = titleForProgram(program)
          const songIndex = programs.indexOf(program) + 1
          setArrangerScan({
            collected: programs.length,
            message: `Retrying “${title}” — will not skip a song with no length`
          })
          const hadLength = isKeepableLengthForTitle(lengthByProgram.get(program) || '', title)
          await captureLengthForProgram(program, songIndex)
          if (
            !hadLength &&
            isKeepableLengthForTitle(lengthByProgram.get(program) || '', title)
          ) {
            lengthsFailed = Math.max(0, lengthsFailed - 1)
          }
        }
      }

      let wasCancelled = arrangerScanCancelled
      if (wasCancelled) {
        stopReason = 'Scan stopped: cancelled by user'
        console.log(`[ViewerOne] Arranger scan: ${stopReason}`)
        await sleep(250)
        if (latestSongProgram !== null) currentProgram = latestSongProgram
      }

      const written = [...lengthByProgram.values()]
      if (isDuplicateLengthGarbage(written, programs.length)) {
        console.warn(
          `[ViewerOne] Arranger scan: REJECTED — ${written.length} songs share the same length (garbage OCR); keeping prior lengths`
        )
        lengthByProgram.clear()
        lengthsFailed += lengthsOk
        lengthsOk = 0
        lengthPassSkippedReason =
          'identical lengths rejected (likely wrong Info Line / timer OCR) — prior lengths kept'
        publishProgressSetlist()
      }

      if (wasCancelled) {
        setArrangerScan({
          active: true,
          phase: 'returning',
          collected: programs.length,
          message: 'Scan cancelled; returning to the beginning…'
        })
        midi.flushPendingNoteOffs()
        await rewindArrangerToBeginning(false)
        currentProgram = latestSongProgram ?? currentProgram
        const restoredCancel = currentProgram === startProgram
        setArrangerScan({
          active: false,
          phase: 'cancelled',
          collected: programs.length,
          message: restoredCancel
            ? `${stopReason} — Arranger returned to the starting song · lengths ${lengthsOk} updated.`
            : `${stopReason} — could not confirm return to the starting song · lengths ${lengthsOk} updated.`
        })
        return
      }

      if (programs.length < 2) {
        setState(store, {
          setlist: before.setlist,
          currentSongId: before.currentSongId
        })
        lastEsp32DisplayJson = null
        broadcastState()
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: programs.length,
          message: `${stopReason ?? 'Scan stopped: no song changes received'} — previous setlist kept.`
        })
        return
      }

      publishProgressSetlist()

      console.log(
        `[ViewerOne] Arranger scan: walk END — ${lengthsOk} updated, ${lengthsFailed} missed` +
          (lengthPassSkippedReason ? ` · ${lengthPassSkippedReason}` : '')
      )

      setArrangerScan({
        active: true,
        phase: 'returning',
        collected: programs.length,
        message: `Scan done — returning to first Arranger event (PC ${startProgram})…`
      })
      midi.flushPendingNoteOffs()
      await rewindArrangerToBeginning(false)
      currentProgram = latestSongProgram ?? currentProgram
      const restored = currentProgram === startProgram
      console.log(
        restored
          ? `[ViewerOne] Arranger scan: rewind complete at first song PC ${startProgram}`
          : `[ViewerOne] Arranger scan: rewind finished but identity is PC ${currentProgram}; expected first song PC ${startProgram}`
      )


      const lengthBit = lengthPassRan
        ? ` · lengths ${lengthsOk} updated${lengthsFailed ? `, ${lengthsFailed} kept prior` : ''}${
            lengthPassSkippedReason ? ` · aborted (${lengthPassSkippedReason})` : ''
          }`
        : lengthPassSkippedReason
          ? ` · length pass skipped (${lengthPassSkippedReason})`
          : ' · length pass skipped'

      if (wasCancelled) {
        setArrangerScan({
          active: false,
          phase: 'cancelled',
          collected: programs.length,
          message: restored
            ? `${stopReason} — Arranger returned to the starting song${lengthBit}.`
            : `${stopReason} — could not confirm return to the starting song${lengthBit}.`
        })
        return
      }

      const scanned = buildScannedSetlist(programs, before.setlist, lengthByProgram)
      const numberedBefore = countNumberedArrangerSongs(before.setlist)
      const numberedAfter = countNumberedArrangerSongs(scanned)
      const previousTiming = calculateSetlistTiming(before.setlist)
      const newPlaceholders = scanned.filter(
        (row) => row.arrangerIndex != null && /^Song PC \d+$/i.test((row.title ?? '').trim())
      ).length
      const startRow = scanned.find((row) => row.program === startProgram)
      setState(store, {
        setlist: scanned,
        currentSongId: startRow?.id ?? null
      })
      resetCountdownForSong(startRow?.id ?? null)
      // Force CrowPanel/preview refresh even if start song identity is unchanged — n/g totals may have grown.
      lastEsp32DisplayJson = null
      broadcastState()
      const countBit =
        numberedAfter === numberedBefore
          ? `numbered total still ${numberedAfter}`
          : `numbered ${numberedBefore} → ${numberedAfter}`
      const placeholderBit =
        newPlaceholders > 0
          ? ` · ${newPlaceholders} new Song PC row(s) — set title/PC metadata in ViewerOne`
          : ''
      console.log(
        '[ViewerOne] Arranger scan lengths:\n' +
          scanned
            .filter((row) => row.arrangerIndex != null)
            .map((row) => `  ${row.arrangerIndex}. ${row.title} ${row.length || '(none)'}`)
            .join('\n')
      )
      const timing = calculateSetlistTiming(scanned)
      const audit = auditSetlistLengths(scanned, {
        freshLengthCount: lengthsOk,
        previousMainSeconds: previousTiming.main,
        previousNumbered: numberedBefore
      })
      for (const warning of audit.warnings) {
        console.warn(`[ViewerOne] Arranger scan length check: ${warning}`)
      }
      const gig = scanIsGigReady(scanned, {
        freshLengthCount: lengthsOk,
        lengthFailures: lengthsFailed,
        previousVisited: before.setlist.filter((row) => row.arrangerIndex != null).length,
        previousNumbered: numberedBefore,
        previousMainSeconds: previousTiming.main
      })
      if (!gig.ready) {
        console.warn(`[ViewerOne] Arranger scan NOT gig-ready: ${gig.blockers.join('; ')}`)
      }
      try {
        const leftoverLines = scanned
          .filter((row) => row.arrangerIndex == null && songLengthSeconds(row.length) > 0)
          .map((row) => `LEFTOVER\t${row.program}\t${row.length || ''}\t${row.title}`)
        writeFileSync(
          join(app.getPath('userData'), 'last-arranger-scan.txt'),
          [
            ...scanned
              .filter((row) => row.arrangerIndex != null)
              .map(
                (row) => `${row.arrangerIndex}\t${row.program}\t${row.length || ''}\t${row.title}`
              ),
            `INTRO\t${formatSetlistSeconds(timing.intro)}\t${timing.intro}`,
            `MAIN\t${formatSetlistSeconds(timing.main)}\t${timing.main}`,
            `OUTRO\t${formatSetlistSeconds(timing.outro)}\t${timing.outro}`,
            `TOTAL\t${formatSetlistSeconds(timing.total)}\t${timing.total}`,
            `UNVISITED\t${audit.unvisited.rows}\t${formatSetlistSeconds(audit.unvisited.seconds)}\t${audit.unvisited.seconds}`,
            `LENGTHS\tok=${lengthsOk}\tfailed=${lengthsFailed}`,
            `GIGREADY\t${gig.ready ? 'READY' : 'BLOCKED'}\t${gig.blockers.join('; ')}`,
            ...leftoverLines,
            ...audit.warnings.map((w) => `WARN\t${w}`)
          ].join('\n') + '\n'
        )
      } catch {
        /* ignore */
      }
      const mainBit = ` · numbered songs ${formatSetlistSeconds(timing.main)} · set ${formatSetlistSeconds(timing.total)}`
      const leftoverBit =
        audit.unvisited.withLength > 0
          ? ` · ${audit.unvisited.rows} leftover not in arranger excluded (${formatSetlistSeconds(audit.unvisited.seconds)})`
          : ''
      const auditBit = audit.warnings
        .filter((w) => !w.includes('leftover row'))
        .map((w) => ` · ${w}`)
        .join('')
      const lengthLooksWrong =
        !gig.ready ||
        audit.warnings.some((w) =>
          /stale|barely changed|average numbered|suspiciously long|have no length/i.test(w)
        )
      const missingBit = gig.blockers.length
        ? ` — INCOMPLETE: ${gig.blockers.join('; ')}`
        : ''
      // Lengths/order decide complete vs error. A failed rewind-home must not
      // mark the set "not gig-ready" when the walk itself is solid.
      setArrangerScan({
        active: false,
        phase: lengthLooksWrong ? 'error' : 'complete',
        collected: programs.length,
        message: restored
          ? `${stopReason ?? 'Scan stopped'} — saved ${programs.length} in arranger order (${countBit})${placeholderBit}${lengthBit}${mainBit}${leftoverBit}${auditBit}${missingBit}; returned to PC ${startProgram}.`
          : `${stopReason ?? 'Scan stopped'} — saved ${programs.length} (${countBit})${placeholderBit}${lengthBit}${mainBit}${leftoverBit}${auditBit}${missingBit}, but could not confirm return to PC ${startProgram}.`
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[ViewerOne] Arranger scan crashed —', message)
      setArrangerScan({
        active: false,
        phase: 'error',
        collected: arrangerScan.collected,
        message: `Arranger scan failed: ${message}`
      })
    } finally {
      midi.flushPendingNoteOffs()
      arrangerScanCancelled = false
      if (arrangerScan.active) {
        setArrangerScan({
          active: false,
          phase: arrangerScan.phase === 'cancelled' ? 'cancelled' : 'error',
          collected: arrangerScan.collected,
          message: arrangerScan.message || 'Arranger scan ended.'
        })
      }
    }
  })()

  try {
    await arrangerScanPromise
  } finally {
    arrangerScanPromise = null
  }
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
    title: `ViewerOne v${formatViewerOneVersion(app.getVersion())} — Control`,
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
      ledPattern: clampLedPatternId(row.ledPattern),
      backingTrackPath:
        typeof row.backingTrackPath === 'string' && row.backingTrackPath.trim()
          ? row.backingTrackPath.trim()
          : undefined,
      audioAnalysis: normalizeSongAudioAnalysis(row.audioAnalysis),
      lightingProgram: normalizeLightingProgram(row.lightingProgram),
      audioSource: row.audioSource,
      cubaseRenderPath: row.cubaseRenderPath
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
    // Bridged FX/ALL mutes go through applyBridgedMute for CC out + display tint (not LEDs).
    const bridgedPatches: { def: BridgedMuteDef; muted: boolean }[] = []
    for (const def of BRIDGED_MUTES) {
      if (patch[def.stateKey] !== undefined) {
        bridgedPatches.push({ def, muted: Boolean(patch[def.stateKey]) })
      }
    }
    const synthMutedToApply =
      patch.synthMuted !== undefined ? Boolean(patch.synthMuted) : undefined
    const pianoMutedToApply =
      patch.pianoMuted !== undefined ? Boolean(patch.pianoMuted) : undefined
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
    if (patch.transportMidi && typeof patch.transportMidi === 'object') {
      const raw = patch.transportMidi
      const channelRaw = Number(raw.channel)
      const channel = Number.isFinite(channelRaw)
        ? Math.max(0, Math.min(16, Math.round(channelRaw)))
        : st.transportMidi.channel
      allowed.transportMidi = {
        mode: raw.mode === 'cc' ? 'cc' : 'note',
        channel,
        startNumber: Math.max(0, Math.min(127, Math.round(Number(raw.startNumber ?? st.transportMidi.startNumber)))),
        stopNumber: Math.max(0, Math.min(127, Math.round(Number(raw.stopNumber ?? st.transportMidi.stopNumber))))
      }
      transportHint = null
      console.log(
        `[ViewerOne] MIDI: transport map updated mode=${allowed.transportMidi.mode} ` +
          `ch=${allowed.transportMidi.channel || 'any'} start=${allowed.transportMidi.startNumber} ` +
          `stop=${allowed.transportMidi.stopNumber}`
      )
    }
    if (patch.countdownStartLeadMs !== undefined) {
      allowed.countdownStartLeadMs = clampCountdownStartLeadMs(
        patch.countdownStartLeadMs,
        st.countdownStartLeadMs
      )
      console.log(`[ViewerOne] countdown start lead set to ${allowed.countdownStartLeadMs}ms`)
    }
    if (patch.lightingDirectorEnabled !== undefined) {
      allowed.lightingDirectorEnabled = Boolean(patch.lightingDirectorEnabled)
    }
    if (patch.liveAudioSyncEnabled !== undefined) {
      allowed.liveAudioSyncEnabled = Boolean(patch.liveAudioSyncEnabled)
    }
    if (patch.lightingLoopbackDevice !== undefined) {
      const dev = String(patch.lightingLoopbackDevice).trim()
      if (dev) allowed.lightingLoopbackDevice = dev
    }
    if (patch.lightingCaptureMode === 'export' || patch.lightingCaptureMode === 'playback') {
      allowed.lightingCaptureMode = patch.lightingCaptureMode
    }
    if (patch.cubaseExportFolder !== undefined) {
      const folder = String(patch.cubaseExportFolder).trim()
      allowed.cubaseExportFolder = folder || undefined
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
    for (const { def, muted } of bridgedPatches) {
      applyBridgedMute(def, muted, { sendToCubase: true, sendToMixer: true })
    }
    if (synthMutedToApply !== undefined) {
      applyChannelMuted('synth', synthMutedToApply, { sendToCubase: true, source: 'preview/ui' })
    }
    if (pianoMutedToApply !== undefined) {
      applyChannelMuted('piano', pianoMutedToApply, { sendToCubase: true, source: 'preview/ui' })
    }
    if (allowed.esp32Enabled !== undefined) {
      syncEsp32SerialFromStore()
    }
    if (allowed.ledBrightness !== undefined || allowed.ledExternalPower !== undefined) {
      pushEsp32BrightnessFromSettings()
    }
    if (
      allowed.lightingDirectorEnabled !== undefined ||
      allowed.liveAudioSyncEnabled !== undefined
    ) {
      if (!getState(store).lightingDirectorEnabled) {
        lightingDirector.disarm()
      }
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

  ipcMain.handle('arranger:scan', async () => {
    await runArrangerScan()
    return buildPublicState()
  })

  ipcMain.handle('arranger:cancelScan', () => {
    if (arrangerScan.active) {
      arrangerScanCancelled = true
      setArrangerScan({ message: 'Cancelling; returning to the starting song…' })
    }
    return buildPublicState()
  })

  /** Grab Cubase Info Line Length for the current setlist song (select event in Cubase first). */
  ipcMain.handle('arranger:grabLength', async () => {
    if (arrangerScan.active) return buildPublicState()
    const st = getState(store)
    const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
    if (!row) {
      setArrangerScan({
        active: false,
        phase: 'error',
        collected: 0,
        message: 'Select a setlist song first, then Grab Length.'
      })
      return buildPublicState()
    }
    const previousLength = row.length || ''
    const title = (row.title || '').trim() || `Song PC ${row.program}`
    setArrangerScan({
      active: false,
      phase: 'scanning',
      collected: 0,
      message: `Reading Cubase Length for “${title}” (Info Line Name must match)…`
    })
    broadcastUiState()
    try {
      const alive = await checkCubaseAlive()
      if (!alive.alive) {
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            (alive.error || 'Cubase not running') +
            (previousLength ? ` — kept ${previousLength}.` : ' — length unchanged.')
        })
        return buildPublicState()
      }
      let prep
      try {
        prep = await prepareCubaseWindowForCapture()
      } catch (prepErr) {
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            (prepErr instanceof Error ? prepErr.message : String(prepErr)) ||
            'Cubase prepare failed — length unchanged.'
        })
        return buildPublicState()
      }
      if (!prep.ok) {
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            (prep.error || 'Could not find Cubase for Length OCR') +
            (previousLength ? ` — kept ${previousLength}.` : ' — length unchanged.')
        })
        return buildPublicState()
      }
      if (transportPlaying) {
        sendCubaseTransportStop('before Grab Length')
        await sleep(200)
      }
      const read = await readCubaseLengthForEvent(title, {
        allowClick: false
      })
      if (/Transport started after Arranger click/i.test(read.error || '')) {
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            'Grab Length aborted — click started playback (MIDI Stop sent)' +
            (previousLength ? ` — kept ${previousLength}.` : ' — length unchanged.')
        })
        return buildPublicState()
      }
      if (!read.ok || !read.mmss || !isKeepableLengthForTitle(read.mmss, title)) {
        const tooLong =
          read.mmss && !isKeepableLengthForTitle(read.mmss, title)
            ? `Rejected ${read.mmss} for “${title}” — too long for one song (click the Arranger event, not a MIDI clip).`
            : ''
        setArrangerScan({
          active: false,
          phase: 'error',
          collected: 0,
          message:
            (tooLong ||
              read.error ||
              'Could not read Cubase Length (select the Arranger event in Cubase so Info Line Name matches, then retry).') +
            (previousLength ? ` — kept ${previousLength}.` : ' — length unchanged.')
        })
        return buildPublicState()
      }
      const mmss = normalizeSongLength(read.mmss)
      const setlist = st.setlist.map((r) => (r.id === row.id ? { ...r, length: mmss } : r))
      setState(store, { setlist })
      if (st.currentSongId === row.id) resetCountdownForSong(row.id)
      lastEsp32DisplayJson = null
      broadcastState()
      setArrangerScan({
        active: false,
        phase: 'complete',
        collected: 1,
        message: `“${title}”: ${statusLengthLabel(mmss)} from Cubase (name matched)`
      })
    } catch (err) {
      setArrangerScan({
        active: false,
        phase: 'error',
        collected: 0,
        message:
          (err instanceof Error ? err.message : String(err)) +
          (previousLength ? ` — kept ${previousLength}.` : ' — length unchanged.')
      })
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

  ipcMain.handle('lighting:pickBackingTrack', async (_e, songId: unknown) => {
    if (typeof songId !== 'string') return buildPublicState()
    const st = getState(store)
    const row = st.setlist.find((r) => r.id === songId)
    if (!row) return buildPublicState()
    const win = BrowserWindow.getFocusedWindow() ?? controlWindow
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: `Backing track — ${row.title || `PC ${row.program}`}`,
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return buildPublicState()
    updateSetlistRow(songId, { backingTrackPath: result.filePaths[0] })
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('lighting:analyzeSong', async (_e, songId: unknown) => {
    if (typeof songId !== 'string') return buildPublicState()
    const st = getState(store)
    const row = st.setlist.find((r) => r.id === songId)
    if (!row?.backingTrackPath) return buildPublicState()
    try {
      const result = await lightingDirector.analyzeSongBackingTrack(row)
      updateSetlistRow(songId, {
        audioAnalysis: result.audioAnalysis,
        lightingProgram: result.lightingProgram,
        audioSource: 'external-file'
      })
      console.log(
        `[ViewerOne] Lighting: analyzed "${row.title}" — ${result.audioAnalysis.bpm} BPM, ${result.lightingProgram.cues.length} cues`
      )
    } catch (err) {
      console.warn('[ViewerOne] Lighting analyze failed:', err)
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('lighting:analyzeAll', async () => {
    const st = getState(store)
    for (const row of st.setlist) {
      if (!row.backingTrackPath) continue
      try {
        const result = await lightingDirector.analyzeSongBackingTrack(row)
        updateSetlistRow(row.id, {
          audioAnalysis: result.audioAnalysis,
          lightingProgram: result.lightingProgram,
          audioSource: 'external-file'
        })
        console.log(
          `[ViewerOne] Lighting: analyzed "${row.title}" — ${result.audioAnalysis.bpm} BPM, ${result.lightingProgram.cues.length} cues`
        )
      } catch (err) {
        console.warn(`[ViewerOne] Lighting analyze failed for "${row.title}":`, err)
      }
    }
    broadcastState()
    return buildPublicState()
  })

  ipcMain.handle('lighting:analyzeFromCubase', async () => {
    await runLightingAnalyzeFromCubase()
    return buildPublicState()
  })

  ipcMain.handle('lighting:cancelAnalyze', () => {
    lightingAnalyzeCancelled = true
    setLightingAnalyze({ phase: 'cancelled', message: 'Cancelling…' })
    return buildPublicState()
  })

  ipcMain.handle('lighting:listLoopbackDevices', async () => {
    try {
      return await listWindowsAudioDevices()
    } catch (err) {
      console.warn('[ViewerOne] List audio devices failed:', err)
      return []
    }
  })

  ipcMain.handle('lighting:startLoopbackMeter', async (_e, deviceName: unknown) => {
    const saved = typeof deviceName === 'string' ? deviceName.trim() : ''
    if (!saved) {
      loopbackMeter.stop()
      return null
    }
    let resolved = saved
    try {
      const devices = await listWindowsAudioDevices()
      resolved = resolveLoopbackDevice(saved, devices) ?? saved
    } catch {
      /* open saved name */
    }
    loopbackMeter.start(resolved)
    return resolved
  })

  ipcMain.handle('lighting:stopLoopbackMeter', () => {
    loopbackMeter.stop()
  })

  ipcMain.handle('lighting:setProgram', (_e, songId: unknown, program: unknown) => {
    if (typeof songId !== 'string' || !program || typeof program !== 'object') {
      return buildPublicState()
    }
    const normalized = normalizeLightingProgram(program)
    if (!normalized) return buildPublicState()
    updateSetlistRow(songId, { lightingProgram: normalized })
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
    startPerformanceSyncTicker()
    setEsp32LineHandler(handleEsp32Line)
    setEsp32ConnectionHandler((connected) => {
      const enabled = getState(store).esp32Enabled
      esp32Display = {
        connection: !enabled ? 'disabled' : connected ? 'connected' : 'searching',
        device: 'unknown',
        model: null,
        width: null,
        height: null,
        fw: null
      }
      if (!isQuitting) broadcastUiState()
    })
    setDmxConnectionHandler(() => {
      if (!isQuitting) broadcastUiState()
    })
    registerIpc()
    connectMidi()
    if (!cubaseInputOpen || !cubaseOutputOpen) {
      scheduleMidiReconnect('startup Cubase ports not fully open')
    }
    syncEsp32SerialFromStore()
    syncDmxFromStore()
    setupAppMenu()
    controlWindow = createControlWindow()

    if (process.argv.includes('--scan-arranger')) {
      setTimeout(() => {
        void (async () => {
          console.log('[ViewerOne] --scan-arranger: starting Scan Arranger')
          await runArrangerScan()
          console.log(`[ViewerOne] --scan-arranger done: ${arrangerScan.phase} — ${arrangerScan.message}`)
        })()
      }, 6000)
    }

    const analyzeMaxArg = process.argv.find((a) => a.startsWith('--lighting-analyze-max='))
    const analyzeTitleArg = process.argv.find((a) => a.startsWith('--lighting-analyze-title='))
    const analyzeProgramArg = process.argv.find((a) => a.startsWith('--lighting-analyze-program='))
    const wantFullAnalyze = process.argv.includes('--lighting-analyze')
    if (wantFullAnalyze || analyzeMaxArg || analyzeTitleArg || analyzeProgramArg) {
      const n = analyzeMaxArg
        ? Math.max(1, Math.round(Number(analyzeMaxArg.split('=')[1]) || 1))
        : undefined
      const onlyTitle = analyzeTitleArg
        ? analyzeTitleArg.slice('--lighting-analyze-title='.length).trim()
        : undefined
      const parsedProgram = analyzeProgramArg
        ? Math.round(Number(analyzeProgramArg.slice('--lighting-analyze-program='.length)))
        : 0
      const onlyProgram = parsedProgram > 0 ? parsedProgram : undefined
      setTimeout(() => {
        void (async () => {
          console.log(
            `[ViewerOne] ${analyzeProgramArg ?? analyzeTitleArg ?? analyzeMaxArg ?? '--lighting-analyze'}: starting Cubase lighting analyze`
          )
          await runLightingAnalyzeFromCubase(n, onlyTitle, onlyProgram)
          console.log(
            `[ViewerOne] lighting analyze done: ${lightingAnalyze.phase} — ${lightingAnalyze.message}`
          )
        })()
      }, 8000)
    }

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

  app.on('before-quit', (e) => {
    if (shutdownFinished) return
    e.preventDefault()
    quitViewerOne()
  })
}
