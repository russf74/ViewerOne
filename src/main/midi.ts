import easymidi from 'easymidi'
import type { MidiSpyEvent } from '../shared/types.js'

export function listInputs(): string[] {
  try {
    return easymidi.getInputs()
  } catch {
    return []
  }
}

export function listOutputs(): string[] {
  try {
    return easymidi.getOutputs()
  } catch {
    return []
  }
}

type PcHandler = (program: number, channel0: number) => void

export type CcHandler = (msg: { channel: number; controller: number; value: number }) => void
export type NoteOnHandler = (msg: { channel: number; note: number; velocity: number }) => void
export type NoteOffHandler = (msg: { channel: number; note: number; velocity: number }) => void
export type MidiSpyHandler = (event: MidiSpyEvent) => void

export type MidiInputHandlers = {
  onProgramChange: PcHandler
  onControlChange?: CcHandler
  onNoteOn?: NoteOnHandler
  onNoteOff?: NoteOffHandler
  onSystemRealtimeStart?: () => void
  onSystemRealtimeStop?: () => void
  onSysexBytes?: (bytes: number[]) => void
  /** Fired for every inbound message on the Cubase input (clock throttled). */
  onSpyEvent?: MidiSpyHandler
}

/** Fired when an open output/input handle is dropped after a send/open failure. */
export type MidiDisconnectHandler = (which: 'cubaseIn' | 'cubaseOut' | 'mixerIn' | 'mixerOut') => void

function safeCall(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.warn(`[ViewerOne] MIDI: ${label} handler threw (swallowed) —`, err)
  }
}

type EasymidiMsg = {
  _type?: string
  channel?: number
  note?: number
  velocity?: number
  controller?: number
  value?: number
  number?: number
  bytes?: number[]
}

/** Format one easymidi message for the Cubase MIDI spy. */
export function formatMidiSpyEvent(msg: EasymidiMsg, atMs = Date.now()): MidiSpyEvent | null {
  const type = msg._type ?? 'other'
  if (type === 'clock' || type === 'activesense') {
    return { atMs, kind: 'clock', summary: type === 'clock' ? 'MIDI clock' : 'active sensing' }
  }
  if (type === 'start') return { atMs, kind: 'start', summary: 'realtime START (0xFA)' }
  if (type === 'continue') return { atMs, kind: 'continue', summary: 'realtime CONTINUE (0xFB)' }
  if (type === 'stop') return { atMs, kind: 'stop', summary: 'realtime STOP (0xFC)' }

  const ch = typeof msg.channel === 'number' ? msg.channel + 1 : null
  if (type === 'noteon') {
    return {
      atMs,
      kind: 'noteon',
      summary: `ch${ch ?? '?'} note ${msg.note ?? '?'} vel ${msg.velocity ?? 0}`
    }
  }
  if (type === 'noteoff') {
    return {
      atMs,
      kind: 'noteoff',
      summary: `ch${ch ?? '?'} note ${msg.note ?? '?'} off`
    }
  }
  if (type === 'cc') {
    return {
      atMs,
      kind: 'cc',
      summary: `ch${ch ?? '?'} CC ${msg.controller ?? '?'} = ${msg.value ?? 0}`
    }
  }
  if (type === 'program') {
    const wire = msg.number ?? 0
    return {
      atMs,
      kind: 'program',
      summary: `ch${ch ?? '?'} PC ${wire + 1} (wire ${wire})`
    }
  }
  if (type === 'sysex') {
    const bytes = msg.bytes ?? []
    const mmc = parseMmcTransportCommand(bytes)
    if (mmc) {
      return {
        atMs,
        kind: 'mmc',
        summary: `MMC ${mmc}${formatSysexPreview(bytes)}`
      }
    }
    return { atMs, kind: 'sysex', summary: `sysex${formatSysexPreview(bytes)}` }
  }
  return { atMs, kind: 'other', summary: type }
}

function formatSysexPreview(bytes: number[]): string {
  if (!bytes.length) return ''
  const head = bytes
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
  return bytes.length > 8 ? ` [${head} …]` : ` [${head}]`
}

export class MidiService {
  private input: easymidi.Input | null = null
  private output: easymidi.Output | null = null
  private mixerInput: easymidi.Input | null = null
  private mixerOutput: easymidi.Output | null = null
  /** Preferred channel for *outgoing* Cubase Program Change (0-based). Incoming PC accepts any channel. */
  private pcChannel0: number = 0
  private handlers: MidiInputHandlers | null = null
  private onDisconnect: MidiDisconnectHandler | null = null
  /** Throttle MIDI clock / active sensing in the spy so Play/Stop stays visible. */
  private lastClockSpyAtMs = 0

  setDisconnectHandler(handler: MidiDisconnectHandler | null): void {
    this.onDisconnect = handler
  }

  private notifyDisconnect(which: 'cubaseIn' | 'cubaseOut' | 'mixerIn' | 'mixerOut'): void {
    try {
      this.onDisconnect?.(which)
    } catch (err) {
      console.warn('[ViewerOne] MIDI: disconnect handler threw —', err)
    }
  }

  setProgramChangeChannel(channel1to16: number): void {
    this.pcChannel0 = Math.max(0, Math.min(15, channel1to16 - 1))
  }

  /** Returns true if the Cubase/loopMIDI input was opened successfully. */
  openInput(name: string | null, handlers: MidiInputHandlers): boolean {
    this.closeInput()
    this.handlers = handlers
    this.lastClockSpyAtMs = 0
    const onPc = handlers.onProgramChange
    if (!name) {
      console.warn('[ViewerOne] MIDI: no Cubase input port detected — check loopMIDI is running with the expected cable names.')
      return false
    }
    const available = listInputs()
    if (!available.includes(name)) {
      console.warn(
        `[ViewerOne] MIDI: saved input "${name}" is not in the current device list. Available: ${available.length ? available.join(', ') : '(none)'}`
      )
    }
    try {
      this.input = new easymidi.Input(name)
      // Accept Program Change on ANY channel. Cubase track MIDI channels often default to 1;
      // filtering to CUBASE_PC_CHANNEL alone silently dropped every PC when the DAW sent ch1.
      this.input.on('program', (msg) => {
        safeCall('program', () => {
          console.log(
            `[ViewerOne] MIDI: <<< Cubase PC wire=${msg.number} (UI ${msg.number + 1}) ch ${msg.channel + 1} on "${name}" (preferred out ch ${this.pcChannel0 + 1})`
          )
          onPc?.(msg.number, msg.channel)
        })
      })
      const onCc = handlers.onControlChange
      if (onCc) {
        this.input.on('cc', (msg) => {
          safeCall('cc', () => {
            onCc({ channel: msg.channel, controller: msg.controller, value: msg.value })
          })
        })
      }
      const onNoteOn = handlers.onNoteOn
      if (onNoteOn) {
        this.input.on('noteon', (msg) => {
          // Velocity 0 is a note-off alias — still forward so transport can treat it as Stop if mapped.
          safeCall('noteon', () => {
            onNoteOn({ channel: msg.channel, note: msg.note, velocity: msg.velocity })
          })
        })
      }
      const onNoteOff = handlers.onNoteOff
      if (onNoteOff) {
        this.input.on('noteoff', (msg) => {
          safeCall('noteoff', () => {
            onNoteOff({ channel: msg.channel, note: msg.note, velocity: msg.velocity })
          })
        })
      }
      // easymidi exposes realtime via typed events (see INPUT_EXTENDED_TYPES 0xFA/FB/FC).
      // Subscribe explicitly — do not rely on a raw-byte path.
      if (handlers.onSystemRealtimeStart) {
        this.input.on('start', () => {
          console.log('[ViewerOne] MIDI: <<< realtime START (0xFA)')
          safeCall('start', () => handlers.onSystemRealtimeStart?.())
        })
        this.input.on('continue', () => {
          console.log('[ViewerOne] MIDI: <<< realtime CONTINUE (0xFB)')
          safeCall('continue', () => handlers.onSystemRealtimeStart?.())
        })
      }
      if (handlers.onSystemRealtimeStop) {
        this.input.on('stop', () => {
          console.log('[ViewerOne] MIDI: <<< realtime STOP (0xFC)')
          safeCall('stop', () => handlers.onSystemRealtimeStop?.())
        })
      }
      if (handlers.onSysexBytes) {
        this.input.on('sysex', (msg) => {
          const bytes = msg.bytes
          if (!bytes?.length) return
          safeCall('sysex', () => handlers.onSysexBytes?.(bytes))
        })
      }
      // Unified spy on easymidi's "message" event (fires for every parsed inbound msg).
      if (handlers.onSpyEvent) {
        this.input.on('message', (msg: EasymidiMsg) => {
          safeCall('spy', () => {
            const event = formatMidiSpyEvent(msg)
            if (!event) return
            if (event.kind === 'clock') {
              const now = event.atMs
              if (now - this.lastClockSpyAtMs < 2000) return
              this.lastClockSpyAtMs = now
              event.summary = 'MIDI clock (throttled)'
            }
            handlers.onSpyEvent?.(event)
          })
        })
      }
      const open = this.input.isPortOpen()
      console.log(
        `[ViewerOne] MIDI: listening on "${name}" for PC (any ch), notes/CC, MMC, realtime start/stop — isPortOpen=${open}`
      )
      return open
    } catch (err) {
      this.input = null
      console.warn('[ViewerOne] MIDI: failed to open input port —', name, err)
      return false
    }
  }

  /**
   * Independent MIDI input listened to directly for CC only (the mixer's own USB MIDI port).
   * Kept separate from `openInput` so a mute button on the mixer reaches ViewerOne even if the
   * Cubase-routed input above isn't relaying it for any reason.
   */
  /** Returns true if the port was found and opened successfully. */
  openMixerInput(name: string | null, onCc: CcHandler): boolean {
    this.closeMixerInput()
    if (!name) return false
    const available = listInputs()
    if (!available.includes(name)) {
      console.warn(
        `[ViewerOne] MIDI: saved mixer input "${name}" is not in the current device list. Available: ${available.length ? available.join(', ') : '(none)'}`
      )
    }
    try {
      this.mixerInput = new easymidi.Input(name)
      this.mixerInput.on('cc', (msg) => {
        // Logged unconditionally (not just the mute CC we care about) so a mute sent from
        // ViewerOne that gets echoed/reflected back by the mixer is visible here even if
        // downstream logic in index.ts ends up ignoring it (e.g. echo-suppression window).
        safeCall('mixer-cc', () => {
          console.log(
            `[ViewerOne] MIDI: <<< received from mixer input "${name}" @ ${new Date().toISOString()} — ch ${msg.channel + 1} / CC ${msg.controller} / val ${msg.value}`
          )
          onCc({ channel: msg.channel, controller: msg.controller, value: msg.value })
        })
      })
      console.log(`[ViewerOne] MIDI: listening directly on mixer input "${name}" (isPortOpen=${this.mixerInput.isPortOpen()})`)
      return true
    } catch (err) {
      this.mixerInput = null
      console.warn('[ViewerOne] MIDI: failed to open mixer input port —', name, err)
      return false
    }
  }

  closeMixerInput(): void {
    if (this.mixerInput) {
      try {
        this.mixerInput.removeAllListeners()
        this.mixerInput.close()
      } catch {
        /* ignore */
      }
      this.mixerInput = null
    }
  }

  /**
   * Direct MIDI output to the mixer's own USB port, so ViewerOne can mute/unmute the mixer even
   * with Cubase closed. If Cubase (or anything else) is also holding this port open for its own
   * output, opening it here can throw / silently fail depending on the driver — always caught, so
   * a conflict here degrades to "mixer output not available" rather than crashing the app.
   * Returns true if the port was found and opened successfully.
   */
  openMixerOutput(name: string | null): boolean {
    this.closeMixerOutput()
    if (!name) return false
    const available = listOutputs()
    if (!available.includes(name)) {
      console.warn(
        `[ViewerOne] MIDI: saved mixer output "${name}" is not in the current device list. Available: ${available.length ? available.join(', ') : '(none)'}`
      )
    }
    try {
      this.mixerOutput = new easymidi.Output(name)
      console.log(
        `[ViewerOne] MIDI: opened direct mixer output "${name}" (isPortOpen=${this.mixerOutput.isPortOpen()})`
      )
      return true
    } catch (err) {
      this.mixerOutput = null
      console.warn('[ViewerOne] MIDI: failed to open mixer output port (in use elsewhere, e.g. by Cubase?) —', name, err)
      return false
    }
  }

  closeMixerOutput(): void {
    if (this.mixerOutput) {
      try {
        this.mixerOutput.close()
      } catch {
        /* ignore */
      }
      this.mixerOutput = null
    }
  }

  /** Drop a broken mixer output handle and notify so the UI can reconnect. */
  private dropMixerOutput(reason: unknown): void {
    console.warn('[ViewerOne] MIDI: mixer output lost —', reason)
    this.closeMixerOutput()
    this.notifyDisconnect('mixerOut')
  }

  /** Drop a broken Cubase output handle and notify so the UI can reconnect. */
  private dropCubaseOutput(reason: unknown): void {
    console.warn('[ViewerOne] MIDI: Cubase output lost —', reason)
    this.closeOutput()
    this.notifyDisconnect('cubaseOut')
  }

  /** Control change straight to the mixer; channel 1–16, value 0–127. No-op if not open. */
  sendMixerControlChange(channel1to16: number, controller: number, value: number): void {
    const tag = `ch ${channel1to16} / CC ${controller} / val ${value}`
    if (!this.mixerOutput) {
      console.warn(`[ViewerOne] MIDI: >>> sendMixerControlChange(${tag}) SKIPPED — no mixerOutput handle open`)
      return
    }
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const cc = Math.max(0, Math.min(127, controller))
    const v = Math.max(0, Math.min(127, value))
    const isOpenBefore = this.mixerOutput.isPortOpen()
    console.log(
      `[ViewerOne] MIDI: >>> about to send to mixer output @ ${new Date().toISOString()} — ${tag} (wire ch0=${ch}) — isPortOpen=${isOpenBefore}`
    )
    try {
      if (!isOpenBefore) {
        this.dropMixerOutput('port not open before send')
        return
      }
      this.mixerOutput.send('cc', { controller: cc, value: v, channel: ch })
      console.log(
        `[ViewerOne] MIDI: <<< mixerOutput.send() returned normally @ ${new Date().toISOString()} — ${tag} — isPortOpen after=${this.mixerOutput.isPortOpen()}`
      )
    } catch (err) {
      console.warn(`[ViewerOne] MIDI: !!! mixerOutput.send() THREW for ${tag} —`, err)
      this.dropMixerOutput(err)
    }
  }

  /** Returns true if the Cubase/loopMIDI output was opened successfully. */
  openOutput(name: string | null): boolean {
    this.closeOutput()
    if (!name) return false
    try {
      this.output = new easymidi.Output(name)
      console.log(`[ViewerOne] MIDI: opened Cubase output "${name}"`)
      return true
    } catch (err) {
      this.output = null
      console.warn('[ViewerOne] MIDI: failed to open Cubase output —', name, err)
      return false
    }
  }

  closeInput(): void {
    if (this.input) {
      try {
        this.input.removeAllListeners()
        this.input.close()
      } catch {
        /* ignore */
      }
      this.input = null
    }
    this.handlers = null
  }

  closeOutput(): void {
    if (this.output) {
      try {
        this.output.close()
      } catch {
        /* ignore */
      }
      this.output = null
    }
  }

  /** Setlist/UI use programs 1–119; wire value is program − 1. PCs 120–127 are reserved. */
  sendProgramChange(channel1to16: number, program1to127: number): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const wire = Math.max(0, Math.min(127, program1to127 - 1))
    try {
      if (!this.output.isPortOpen()) {
        this.dropCubaseOutput('port not open before program send')
        return
      }
      this.output.send('program', { number: wire, channel: ch })
    } catch (err) {
      console.warn('[ViewerOne] MIDI: Cubase program send failed —', err)
      this.dropCubaseOutput(err)
    }
  }

  /** Control change; channel 1–16, value 0–127 */
  sendControlChange(channel1to16: number, controller: number, value: number): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const cc = Math.max(0, Math.min(127, controller))
    const v = Math.max(0, Math.min(127, value))
    try {
      if (!this.output.isPortOpen()) {
        this.dropCubaseOutput('port not open before cc send')
        return
      }
      this.output.send('cc', { controller: cc, value: v, channel: ch })
    } catch (err) {
      console.warn('[ViewerOne] MIDI: Cubase CC send failed —', err)
      this.dropCubaseOutput(err)
    }
  }

  /** Short Note On/Off pulse on the existing Cubase output; suitable for Generic Remote commands. */
  sendNotePulse(channel1to16: number, note: number, velocity = 127, durationMs = 60): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const n = Math.max(0, Math.min(127, note))
    const v = Math.max(1, Math.min(127, velocity))
    try {
      if (!this.output.isPortOpen()) {
        this.dropCubaseOutput('port not open before note send')
        return
      }
      const output = this.output
      output.send('noteon', { note: n, velocity: v, channel: ch })
      setTimeout(() => {
        try {
          if (output === this.output && output.isPortOpen()) {
            output.send('noteoff', { note: n, velocity: 0, channel: ch })
          }
        } catch (err) {
          if (output === this.output) this.dropCubaseOutput(err)
        }
      }, Math.max(1, durationMs))
    } catch (err) {
      console.warn('[ViewerOne] MIDI: Cubase note send failed —', err)
      this.dropCubaseOutput(err)
    }
  }
}

/**
 * Parse MMC Universal Real Time SysEx Play/Stop.
 * Accepts any device ID; Play (02), Deferred Play (03), Stop (01), Pause (09).
 */
export function parseMmcTransportCommand(bytes: number[]): 'play' | 'stop' | null {
  if (bytes.length < 6 || bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return null
  // Universal Real Time (0x7F), device id any, sub-id MMC (0x06)
  if (bytes[1] !== 0x7f || bytes[3] !== 0x06) return null
  const cmd = bytes[4]
  if (cmd === 0x02 || cmd === 0x03) return 'play'
  if (cmd === 0x01 || cmd === 0x09) return 'stop'
  return null
}
