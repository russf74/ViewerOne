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

type PcHandler = (program: number, channel0: number) => void

export type CcHandler = (msg: { channel: number; controller: number; value: number }) => void

export type MidiInputHandlers = {
  onProgramChange: PcHandler
  onControlChange?: CcHandler
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

export class MidiService {
  private input: easymidi.Input | null = null
  private output: easymidi.Output | null = null
  private mixerInput: easymidi.Input | null = null
  private mixerOutput: easymidi.Output | null = null
  /** Preferred channel for *outgoing* Cubase Program Change (0-based). Incoming PC accepts any channel. */
  private pcChannel0: number = 0
  private handlers: MidiInputHandlers | null = null
  private onDisconnect: MidiDisconnectHandler | null = null

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
      const open = this.input.isPortOpen()
      console.log(
        `[ViewerOne] MIDI: listening on "${name}" for Program Change on ANY channel (outgoing PC uses ch ${this.pcChannel0 + 1}) — isPortOpen=${open}`
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

  /** Setlist / UI use program 1–125 (Cubase-style); wire value is program − 1. PC 126/127 are LED reserved. */
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
}
