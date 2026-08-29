/** Offline audio analysis — pure functions (no I/O). */

export type SongSectionLabel =
  | 'intro'
  | 'verse'
  | 'prechorus'
  | 'chorus'
  | 'bridge'
  | 'breakdown'
  | 'drop'
  | 'outro'
  | 'unknown'

export type SongSection = {
  label: SongSectionLabel
  /** Section start in milliseconds from track start. */
  startMs: number
  /** Normalized energy 0–1 for this section. */
  energy: number
}

export type SongAudioAnalysis = {
  analyzedAt: string
  durationMs: number
  sampleRate: number
  bpm: number
  /** First strong downbeat offset from track start (ms). */
  beatOffsetMs: number
  /** Downsampled beat grid for sync (ms from start). Capped for storage. */
  beatTimesMs: number[]
  sections: SongSection[]
  /** Peak loudness 0–1 — used for intensity scaling. */
  peakEnergy: number
}

const ANALYSIS_SAMPLE_RATE = 22050
const BEAT_TIMES_CAP = 512

/** Resample/decimate mono float PCM to target rate (simple averaging). */
export function resampleMonoPcm(
  samples: Float32Array,
  sourceRate: number,
  targetRate = ANALYSIS_SAMPLE_RATE
): Float32Array {
  if (sourceRate === targetRate) return samples
  const ratio = sourceRate / targetRate
  const outLen = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const frac = src - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

function frameEnergy(samples: Float32Array, frameSize: number): Float32Array {
  const frames = Math.max(1, Math.floor(samples.length / frameSize))
  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const start = f * frameSize
    const end = Math.min(samples.length, start + frameSize)
    for (let i = start; i < end; i++) sum += samples[i] * samples[i]
    energy[f] = Math.sqrt(sum / Math.max(1, end - start))
  }
  return energy
}

function spectralFlux(samples: Float32Array, frameSize: number, hop: number): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hop))
  const flux = new Float32Array(frames)
  let prev = new Float32Array(frameSize / 2)
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    const mag = new Float32Array(frameSize / 2)
    for (let k = 0; k < frameSize / 2; k++) {
      let re = 0
      let im = 0
      for (let n = 0; n < frameSize; n++) {
        const x = samples[start + n] ?? 0
        const angle = (2 * Math.PI * k * n) / frameSize
        re += x * Math.cos(angle)
        im -= x * Math.sin(angle)
      }
      mag[k] = Math.sqrt(re * re + im * im)
    }
    let sum = 0
    for (let k = 0; k < mag.length; k++) {
      const d = mag[k] - prev[k]
      if (d > 0) sum += d
    }
    flux[f] = sum
    prev = mag
  }
  return flux
}

function pickOnsets(flux: Float32Array, hopMs: number): number[] {
  if (flux.length < 3) return []
  const sorted = [...flux].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const threshold = median * 1.4 + 0.002
  const minGapMs = 120
  const onsets: number[] = []
  let lastMs = -minGapMs
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i]
    if (v < threshold) continue
    if (v <= flux[i - 1] || v < flux[i + 1]) continue
    const ms = i * hopMs
    if (ms - lastMs < minGapMs) {
      if (v > (flux[Math.round(lastMs / hopMs)] ?? 0)) {
        onsets[onsets.length - 1] = ms
      }
      continue
    }
    onsets.push(ms)
    lastMs = ms
  }
  return onsets
}

function estimateBpm(onsetsMs: number[]): { bpm: number; offsetMs: number } {
  if (onsetsMs.length < 4) return { bpm: 120, offsetMs: onsetsMs[0] ?? 0 }
  const intervals: number[] = []
  for (let i = 1; i < onsetsMs.length; i++) {
    const d = onsetsMs[i] - onsetsMs[i - 1]
    if (d >= 250 && d <= 1200) intervals.push(d)
  }
  if (intervals.length === 0) return { bpm: 120, offsetMs: onsetsMs[0] ?? 0 }
  intervals.sort((a, b) => a - b)
  const beatMs = intervals[Math.floor(intervals.length / 2)]
  const bpm = Math.max(60, Math.min(200, Math.round(60000 / beatMs)))
  return { bpm, offsetMs: onsetsMs[0] ?? 0 }
}

function buildBeatGrid(durationMs: number, bpm: number, offsetMs: number): number[] {
  const beatMs = 60000 / bpm
  const beats: number[] = []
  let t = Math.max(0, offsetMs)
  while (t <= durationMs && beats.length < BEAT_TIMES_CAP) {
    beats.push(Math.round(t))
    t += beatMs
  }
  return beats
}

function labelSections(energyFrames: Float32Array, frameMs: number, durationMs: number): SongSection[] {
  if (energyFrames.length === 0) {
    return [{ label: 'unknown', startMs: 0, energy: 0.5 }]
  }
  const maxE = Math.max(...energyFrames, 0.001)
  const norm = energyFrames.map((e) => e / maxE)

  // Merge ~4s windows into section boundaries via energy jumps.
  const windowFrames = Math.max(1, Math.round(4000 / frameMs))
  const sections: SongSection[] = []
  let cursor = 0
  let sectionIdx = 0
  while (cursor < norm.length) {
    const end = Math.min(norm.length, cursor + windowFrames)
    let sum = 0
    for (let i = cursor; i < end; i++) sum += norm[i]
    const avg = sum / Math.max(1, end - cursor)
    const startMs = Math.round(cursor * frameMs)
    const label = sectionLabelForIndex(sectionIdx, avg, startMs, durationMs)
    sections.push({ label, startMs, energy: Math.round(avg * 1000) / 1000 })
    cursor = end
    sectionIdx++
  }
  if (sections.length === 0) sections.push({ label: 'unknown', startMs: 0, energy: 0.5 })
  return sections
}

function sectionLabelForIndex(
  index: number,
  energy: number,
  startMs: number,
  durationMs: number
): SongSectionLabel {
  if (startMs < 8000 && index === 0) return 'intro'
  if (startMs > durationMs * 0.88) return 'outro'
  if (energy < 0.35) return index % 2 === 0 ? 'breakdown' : 'verse'
  if (energy > 0.82) return index % 3 === 0 ? 'drop' : 'chorus'
  if (energy > 0.62) return index % 2 === 0 ? 'chorus' : 'prechorus'
  return index % 2 === 0 ? 'verse' : 'bridge'
}

/**
 * Analyze mono PCM (float -1..1). Returns BPM, beat grid, and section map.
 */
export function analyzeMonoPcm(
  samples: Float32Array,
  sampleRate: number,
  durationMsOverride?: number
): SongAudioAnalysis {
  const pcm = resampleMonoPcm(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const durationMs =
    durationMsOverride ?? Math.round((pcm.length / ANALYSIS_SAMPLE_RATE) * 1000)

  const frameSize = 2048
  const hop = 512
  const hopMs = (hop / ANALYSIS_SAMPLE_RATE) * 1000

  const flux = spectralFlux(pcm, frameSize, hop)
  const onsets = pickOnsets(flux, hopMs)
  const { bpm, offsetMs } = estimateBpm(onsets)
  const beatTimesMs = buildBeatGrid(durationMs, bpm, offsetMs)

  const energyFrames = frameEnergy(pcm, hop)
  const sections = labelSections(energyFrames, hopMs, durationMs)

  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i])
    if (a > peak) peak = a
  }

  return {
    analyzedAt: new Date().toISOString(),
    durationMs,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    bpm,
    beatOffsetMs: offsetMs,
    beatTimesMs,
    sections,
    peakEnergy: Math.round(peak * 1000) / 1000
  }
}

/** Nearest beat time (ms) to `atMs`, or null when no grid. */
export function nearestBeatMs(analysis: SongAudioAnalysis, atMs: number): number | null {
  const beats = analysis.beatTimesMs
  if (beats.length === 0) return null
  let best = beats[0]
  let bestDist = Math.abs(atMs - best)
  for (const b of beats) {
    const d = Math.abs(atMs - b)
    if (d < bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}
