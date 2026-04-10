import easymidi from 'easymidi'
import type { AppState } from '../shared/types.js'

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

export type CcHandler = (msg: { channel: number; controller: number; value: number }) => void

export type MidiInputHandlers = {
  onProgramChange: PcHandler
  onControlChange?: CcHandler
}

export class MidiService {
  private input: easymidi.Input | null = null
  private output: easymidi.Output | null = null
  private pcChannel0: number = 0
  private handlers: MidiInputHandlers | null = null

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
      const onCc = handlers.onControlChange
      if (onCc) {
        this.input.on('cc', (msg) => {
          onCc({ channel: msg.channel, controller: msg.controller, value: msg.value })
        })
      }
      console.log(`[ViewerOne] MIDI: listening on "${name}" — Program Change channel ${this.pcChannel0 + 1}`)
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
  }

  reconnectFromState(state: AppState, handlers: MidiInputHandlers): void {
    this.setProgramChangeChannel(state.programChangeChannel)
    this.openInput(state.midiInputName, handlers)
    this.openOutput(state.midiOutputName)
  }

  /** Setlist / UI use program 1–127 (Cubase-style); wire value is program − 1. */
  sendProgramChange(channel1to16: number, program1to127: number): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const wire = Math.max(0, Math.min(127, program1to127 - 1))
    this.output.send('program', { number: wire, channel: ch })
  }

  /** Control change; channel 1–16, value 0–127 */
  sendControlChange(channel1to16: number, controller: number, value: number): void {
    if (!this.output) return
    const ch = Math.max(0, Math.min(15, channel1to16 - 1))
    const cc = Math.max(0, Math.min(127, controller))
    const v = Math.max(0, Math.min(127, value))
    this.output.send('cc', { controller: cc, value: v, channel: ch })
  }
}
