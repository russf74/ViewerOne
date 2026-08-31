/** Peak / RMS from mono float PCM — used by the Lighting Studio loopback meter. */

export type LoopbackMeterSample = {
  /** Instantaneous peak 0–1. */
  peak: number
  /** RMS 0–1. */
  rms: number
  peakDbfs: number
  listening: boolean
  /** True while Analyze (or another exclusive capture) owns the device. */
  paused: boolean
  error: string | null
  device: string
}

export function amplitudeToDbfs(amp: number): number {
  const a = Math.abs(amp)
  if (!Number.isFinite(a) || a <= 1e-8) return -90
  return Math.max(-90, 20 * Math.log10(a))
}

export function measureAudioLevels(samples: ArrayLike<number>): { peak: number; rms: number } {
  const n = samples.length
  if (n === 0) return { peak: 0, rms: 0 }
  let peak = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const v = samples[i] ?? 0
    const a = Math.abs(v)
    if (a > peak) peak = a
    sumSq += v * v
  }
  return {
    peak: Math.min(1, peak),
    rms: Math.min(1, Math.sqrt(sumSq / n))
  }
}

/** Map peak amplitude to a 0–1 meter width on a dB scale (default −60…0). */
export function peakToMeterWidth(peak: number, floorDbfs = -60): number {
  const db = amplitudeToDbfs(peak)
  const span = Math.max(1, -floorDbfs)
  return Math.max(0, Math.min(1, (db - floorDbfs) / span))
}
