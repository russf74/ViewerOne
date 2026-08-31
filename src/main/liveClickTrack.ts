import type { SongAudioAnalysis } from '../shared/audioAnalysis.js'
import { beatIndexAt, beatMsForIndex } from '../shared/clickTrack.js'
import type { ClickTrackSettings } from '../shared/types.js'

export type ClickMidiSendFn = (
  channel: number,
  note: number,
  velocity: number,
  durationMs?: number
) => void

/**
 * Live MIDI click for IEM — fires on beat crossings during transport.
 * Route ViewerOne MIDI out to your IEM mixer / click sample on a dedicated channel.
 */
export class LiveClickTrack {
  private lastBeatIndex = -1
  private armed = false
  private analysis: SongAudioAnalysis | null = null
  private settings: ClickTrackSettings | null = null
  private sendMidi: ClickMidiSendFn = () => {}

  setSendMidi(fn: ClickMidiSendFn): void {
    this.sendMidi = fn
  }

  arm(analysis: SongAudioAnalysis | null, settings: ClickTrackSettings | null): void {
    this.analysis = analysis
    this.settings = settings
    this.lastBeatIndex = -1
    this.armed = Boolean(settings?.liveMidiEnabled && analysis)
  }

  disarm(): void {
    this.armed = false
    this.analysis = null
    this.lastBeatIndex = -1
  }

  /** Call at ~50ms with performance ms from song start; `playing` gates output. */
  tick(performanceMs: number, playing: boolean): void {
    if (!this.armed || !playing || !this.analysis || !this.settings?.liveMidiEnabled) return

    const idx = beatIndexAt(this.analysis, performanceMs)
    if (idx < 0 || idx === this.lastBeatIndex) return

    const settings = this.settings
    const from = this.lastBeatIndex < 0 ? idx : Math.max(this.lastBeatIndex + 1, idx - 1)
    for (let b = from; b <= idx; b++) {
      if (b < 0) continue
      const accent = settings.accentEvery > 0 && b % settings.accentEvery === 0
      const note = accent ? settings.accentNote : settings.midiNote
      const vel = accent ? settings.accentVelocity : settings.velocity
      this.sendMidi(settings.midiChannel, note, vel, accent ? 40 : 25)
    }
    this.lastBeatIndex = idx
  }

  getLastBeatIndex(): number | null {
    return this.lastBeatIndex >= 0 ? this.lastBeatIndex : null
  }

  isEnabled(): boolean {
    return this.armed
  }

  /** Next beat ms from now (for UI countdown to click). */
  nextBeatMs(performanceMs: number): number | null {
    if (!this.analysis) return null
    const idx = beatIndexAt(this.analysis, performanceMs)
    return beatMsForIndex(this.analysis, idx + 1)
  }
}
