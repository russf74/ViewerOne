import easymidi from 'easymidi'
import type { AppState, TransportSettings, CcButtonSettings } from '../shared/types.js'

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

type PcHandler = (program: number) => void

export type CcMsg = { channel: number; controller: number; value: number }
export type NoteOnMsg = { channel: number; note: number; velocity: number }

export type MidiInputHandlers = {
  onProgramChange: PcHandler
  onCc?: (msg: CcMsg) => void
  onSysexBytes?: (bytes: number[]) => void
  onNoteOn?: (msg: NoteOnMsg) => void
  onSystemRealtimeStart?: () => void
  onSystemRealtimeStop?: () => void
}

export class MidiService {
  private input: easymidi.Input | null = null
  private output: easymidi.Output | null = null
  private pcChannel0: number = 0
  private handlers: MidiInputHandlers | null = null
  /** Last CC value sent per ch+controller (toggle127) so we can prime 0→127 after a prior 127. */
  private muteCcLastSent = new Map<string, number>()

  setProgramChangeChannel(channel1to16: number): void {
    this.pcChannel0 = Math.max(0, Math.min(15, channel1to16 - 1))
  }

  openInput(name: string | null, handlers: MidiInputHandlers): void {
    this.closeInput()
    this.handlers = handlers
    const onPc = handlers.onProgramChange
    if (!name) {
      console.warn('[ViewerOne] MIDI: no input port selected — choose one under MIDI input in the control window.')
      return
    }
    const available = listInputs()
    if (!available.includes(name)) {
      console.warn(
        `[ViewerOne] MIDI: saved input "${name}" is not in the current device list. Available: ${available.length ? available.join(', ') : '(none)'}`
      )
    }
    try {
      this.input = new easymidi.Input(name)
      this.input.on('program', (msg) => {
        if (msg.channel !== this.pcChannel0) return
        onPc?.(msg.number)
      })
      if (handlers.onCc) {
        this.input.on('cc', (msg) => {
          handlers.onCc?.({
            channel: msg.channel,
            controller: msg.controller,
            value: msg.value
          })
        })
      }
      if (handlers.onSysexBytes) {
        this.input.on('sysex', (msg: { bytes?: number[] }) => {
          const b = msg.bytes
          if (b && b.length) handlers.onSysexBytes?.(b)
        })
      }
      if (handlers.onNoteOn) {
        this.input.on('noteon', (msg) => {
          if (msg.velocity <= 0) return
          handlers.onNoteOn?.({
            channel: msg.channel,
            note: msg.note,
            velocity: msg.velocity
          })
        })
      }
      if (handlers.onSystemRealtimeStart) {
        this.input.on('start', () => handlers.onSystemRealtimeStart?.())
      }
      if (handlers.onSystemRealtimeStop) {
        this.input.on('stop', () => handlers.onSystemRealtimeStop?.())
      }
      console.log(
        `[ViewerOne] MIDI: listening on "${name}" — Program Change channel ${this.pcChannel0 + 1}; also CC / MMC / notes per handlers`
      )
    } catch (err) {
      this.input = null
      console.warn('[ViewerOne] MIDI: failed to open input port —', name, err)
    }
  }

  openOutput(name: string | null): void {
    this.closeOutput()
    if (!name) return
    try {
      this.output = new easymidi.Output(name)
    } catch {
      this.output = null
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
    this.muteCcLastSent.clear()
  }

  reconnectFromState(state: AppState, handlers: MidiInputHandlers): void {
    this.setProgramChangeChannel(state.programChangeChannel)
    this.openInput(state.midiInputName, handlers)
    this.openOutput(state.midiOutputName)
  }

  sendTransportStart(settings: TransportSettings): void {
    if (!this.output) return
    if (settings.mode === 'mmc') {
      try {
        sendMmc(this.output, MMC_PLAY)
      } catch {
        /* invalid device or sysex unsupported */
      }
      return
    }
    sendNotePulse(this.output, settings.channel, settings.startNote)
  }

  sendTransportStop(settings: TransportSettings): void {
    if (!this.output) return
    if (settings.mode === 'mmc') {
      try {
        sendMmc(this.output, MMC_STOP)
      } catch {
        /* invalid device or sysex unsupported */
      }
      return
    }
    sendNotePulse(this.output, settings.channel, settings.stopNote)
  }

  /**
   * Mute buttons: `toggle127` optional legacy pulse. `absolute` sends valueOn when mute engaged, valueOff when not.
   * Duplicate CC value 0 helps hosts that drop a single zero.
   */
  sendCcToggle(settings: CcButtonSettings, useOn: boolean): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, settings.channel - 1))
    const mode = settings.outMode ?? 'toggle127'
    if (mode === 'toggle127') {
      const key = `${ch}-${settings.cc}`
      const last = this.muteCcLastSent.get(key)
      const out = this.output
      const send = (value: number) => {
        out.send('cc', {
          controller: settings.cc,
          value,
          channel: ch
        })
        this.muteCcLastSent.set(key, value)
      }
      if (last === 127) {
        send(0)
        setTimeout(() => {
          try {
            if (!this.output) return
            this.output.send('cc', {
              controller: settings.cc,
              value: 127,
              channel: ch
            })
            this.muteCcLastSent.set(key, 127)
          } catch {
            /* ignore */
          }
        }, 22)
      } else {
        send(127)
      }
      return
    }
    const value = useOn ? settings.valueOn : settings.valueOff
    this.output.send('cc', {
      controller: settings.cc,
      value,
      channel: ch
    })
    if (value === 0) {
      setTimeout(() => {
        try {
          this.output?.send('cc', {
            controller: settings.cc,
            value: 0,
            channel: ch
          })
        } catch {
          /* ignore */
        }
      }, 20)
    }
  }

  /** Setlist / UI use program 1–127 (Cubase-style); wire value is program − 1. */
  sendProgramChange(channel1to16: number, program1to127: number): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const wire = Math.max(0, Math.min(127, program1to127 - 1))
    this.output.send('program', { number: wire, channel: ch })
  }
}

/** MMC Stop (sub-ID 1) */
const MMC_STOP = [0xf0, 0x7f, 0x7f, 0x06, 0x01, 0xf7] as const
/** MMC Play (sub-ID 1) */
const MMC_PLAY = [0xf0, 0x7f, 0x7f, 0x06, 0x02, 0xf7] as const

function sendMmc(out: easymidi.Output, bytes: readonly number[]): void {
  out.send('sysex', [...bytes])
}

function sendNotePulse(out: easymidi.Output, channel1to16: number, note: number): void {
  const ch = Math.max(0, Math.min(15, channel1to16 - 1))
  const n = Math.max(0, Math.min(127, note))
  out.send('noteon', { note: n, velocity: 127, channel: ch })
  setTimeout(() => {
    try {
      out.send('noteoff', { note: n, velocity: 0, channel: ch })
    } catch {
      /* ignore */
    }
  }, 80)
}

/** Parse MMC Universal Real Time SysEx for play/stop. */
export function parseMmcTransportCommand(bytes: number[]): 'play' | 'stop' | null {
  if (bytes.length < 6) return null
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return null
  if (bytes[1] === 0x7f && bytes[2] === 0x7f && bytes[3] === 0x06) {
    const cmd = bytes[4]
    if (cmd === 0x02) return 'play'
    if (cmd === 0x01) return 'stop'
  }
  return null
}
