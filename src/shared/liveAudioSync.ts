import { nearestBeatMs, type SongAudioAnalysis } from './audioAnalysis.js'

/**
 * Real-time onset tracker that nudges performance clock toward the pre-analyzed beat grid.
 * Feed mono PCM chunks from loopback / rehearsal playback.
 */
export class LiveBeatSync {
  private analysis: SongAudioAnalysis | null = null
  private syncOffsetMs = 0
  private lastOnsetMs = 0
  private performanceMs = 0
  private energyHistory: number[] = []
  private readonly maxHistory = 32

  setAnalysis(analysis: SongAudioAnalysis | null): void {
    this.analysis = analysis
    this.syncOffsetMs = 0
    this.lastOnsetMs = 0
    this.energyHistory = []
  }

  resetPerformance(performanceMs = 0): void {
    this.performanceMs = performanceMs
    this.syncOffsetMs = 0
    this.lastOnsetMs = 0
    this.energyHistory = []
  }

  getSyncOffsetMs(): number {
    return this.syncOffsetMs
  }

  /** Performance clock including live nudge. */
  adjustedPerformanceMs(rawPerformanceMs: number): number {
    return Math.max(0, rawPerformanceMs + this.syncOffsetMs)
  }

  /**
   * Process a mono PCM chunk. `chunkStartMs` is where this chunk begins in the performance timeline.
   */
  processChunk(samples: Float32Array, chunkStartMs: number): void {
    if (!this.analysis || samples.length === 0) return

    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / samples.length)
    this.energyHistory.push(rms)
    if (this.energyHistory.length > this.maxHistory) this.energyHistory.shift()

    const avg =
      this.energyHistory.reduce((a, b) => a + b, 0) / Math.max(1, this.energyHistory.length)
    const threshold = avg * 1.55 + 0.01
    if (rms < threshold) return

    const now = chunkStartMs
    if (now - this.lastOnsetMs < 100) return
    this.lastOnsetMs = now

    const perfMs = this.adjustedPerformanceMs(this.performanceMs)
    const nearest = nearestBeatMs(this.analysis, perfMs)
    if (nearest == null) return

    const error = nearest - perfMs
    if (Math.abs(error) > 180) return

    // Gentle PLL — pull toward grid without wild swings.
    this.syncOffsetMs += error * 0.12
    this.syncOffsetMs = Math.max(-250, Math.min(250, this.syncOffsetMs))
  }

  setPerformanceMs(ms: number): void {
    this.performanceMs = ms
  }
}
