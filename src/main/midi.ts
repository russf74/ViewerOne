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

export class MidiService {
  private input: easymidi.Input | null = null
  private output: easymidi.Output | null = null
  private pcChannel0: number = 0
  private onPc: PcHandler | null = null

  setProgramChangeChannel(channel1to16: number): void {
    this.pcChannel0 = Math.max(0, Math.min(15, channel1to16 - 1))
  }

  openInput(name: string | null, onProgramChange: PcHandler): void {
    this.closeInput()
    this.onPc = onProgramChange
    if (!name) return
    try {
      this.input = new easymidi.Input(name)
      this.input.on('program', (msg) => {
        if (msg.channel !== this.pcChannel0) return
        this.onPc?.(msg.number)
      })
    } catch {
      this.input = null
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
        this.input.close()
      } catch {
        /* ignore */
      }
      this.input = null
    }
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

  reconnectFromState(state: AppState, onProgramChange: PcHandler): void {
    this.setProgramChangeChannel(state.programChangeChannel)
    this.openInput(state.midiInputName, onProgramChange)
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

  sendCcToggle(settings: CcButtonSettings, useOn: boolean): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, settings.channel - 1))
    const value = useOn ? settings.valueOn : settings.valueOff
    this.output.send('cc', {
      controller: settings.cc,
      value,
      channel: ch
    })
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
