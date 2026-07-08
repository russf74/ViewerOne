import easymidi from 'easymidi'

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
  private mixerInput: easymidi.Input | null = null
  private mixerOutput: easymidi.Output | null = null
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
      console.warn('[ViewerOne] MIDI: no Cubase input port detected — check loopMIDI is running with the expected cable names.')
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
        console.log(
          `[ViewerOne] MIDI: <<< received from mixer input "${name}" @ ${new Date().toISOString()} — ch ${msg.channel + 1} / CC ${msg.controller} / val ${msg.value}`
        )
        onCc({ channel: msg.channel, controller: msg.controller, value: msg.value })
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
      this.mixerOutput.send('cc', { controller: cc, value: v, channel: ch })
      console.log(
        `[ViewerOne] MIDI: <<< mixerOutput.send() returned normally @ ${new Date().toISOString()} — ${tag} — isPortOpen after=${this.mixerOutput.isPortOpen()}`
      )
    } catch (err) {
      console.warn(`[ViewerOne] MIDI: !!! mixerOutput.send() THREW for ${tag} —`, err)
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
