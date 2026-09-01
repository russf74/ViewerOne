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

/** Half-wave energy flux of a 1-pole highpass — O(n), not a DFT. */
function spectralFlux(samples: Float32Array, frameSize: number, hop: number): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hop))
  const flux = new Float32Array(frames)
  let prev = 0
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    let sum = 0
    let hpPrev = samples[start] ?? 0
    for (let n = 1; n < frameSize; n++) {
      const x = samples[start + n] ?? 0
      const hp = x - hpPrev
      hpPrev = x
      sum += hp * hp
    }
    const energy = Math.sqrt(sum / Math.max(1, frameSize - 1))
    flux[f] = Math.max(0, energy - prev)
    prev = energy
  }
  return flux
}

function peakOf(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  return peak
}

/** Scale to ~0.95 peak so quiet Stereo Mix captures still have usable onsets. */
function peakNormalize(samples: Float32Array, peak: number, target = 0.95): Float32Array {
  if (peak < 0.004) return samples
  const g = target / peak
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g
  return out
}

function energyNovelty(energy: Float32Array): Float32Array {
  const out = new Float32Array(energy.length)
  for (let i = 1; i < energy.length; i++) {
    out[i] = Math.max(0, energy[i] - energy[i - 1])
  }
  return out
}

function combineNovelty(flux: Float32Array, energyNov: Float32Array): Float32Array {
  const n = Math.min(flux.length, energyNov.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = flux[i] + energyNov[i]
  return out
}

function meanNoveltyOnGrid(
  novelty: Float32Array,
  hopMs: number,
  beatMs: number,
  offsetMs: number
): number {
  let sum = 0
  let n = 0
  const lastMs = novelty.length * hopMs
  for (let t = offsetMs; t < lastMs; t += beatMs) {
    const i = t / hopMs
    const i0 = Math.floor(i)
    if (i0 < 0 || i0 >= novelty.length) continue
    const frac = i - i0
    const a = novelty[i0] ?? 0
    const b = novelty[i0 + 1] ?? a
    sum += a * (1 - frac) + b * frac
    n++
  }
  return n > 0 ? sum / n : 0
}

function noveltyAutocorr(novelty: Float32Array, lag: number): number {
  if (lag < 1 || lag >= novelty.length) return 0
  let sum = 0
  let n = 0
  const end = novelty.length - lag
  for (let i = 0; i < end; i++) {
    sum += novelty[i] * novelty[i + lag]
    n++
  }
  return n > 0 ? sum / n : 0
}

function smoothNovelty(novelty: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(novelty.length)
  for (let i = 0; i < novelty.length; i++) {
    let sum = 0
    let n = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j >= 0 && j < novelty.length) {
        sum += novelty[j]
        n++
      }
    }
    out[i] = n > 0 ? sum / n : 0
  }
  return out
}

function trackTempoAndPhase(novelty: Float32Array, hopMs: number): { bpm: number; offsetMs: number } {
  if (novelty.length < 8) return { bpm: 120, offsetMs: 0 }
  const minBpm = 84
  const maxBpm = 200
  const smoothed = smoothNovelty(novelty, 3)
  let bestBpm = 120
  let bestScore = -1
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    const beatMs = 60000 / bpm
    const steps = Math.max(4, Math.round(beatMs / hopMs))
    for (let s = 0; s < steps; s++) {
      const score = meanNoveltyOnGrid(smoothed, hopMs, beatMs, s * hopMs)
      if (score > bestScore) {
        bestScore = score
        bestBpm = bpm
      }
    }
  }
  if (bestBpm < 92 && bestBpm * 2 <= maxBpm) {
    bestBpm *= 2
  }

  const beatMs = 60000 / bestBpm
  const steps = Math.max(4, Math.round(beatMs / hopMs))
  let bestOff = 0
  let bestOffScore = -1
  for (let s = 0; s < steps; s++) {
    const offsetMs = s * hopMs
    const score = meanNoveltyOnGrid(novelty, hopMs, beatMs, offsetMs)
    const closer = offsetMs < bestOff && score >= bestOffScore * 0.985
    if (score > bestOffScore || closer) {
      bestOffScore = Math.max(bestOffScore, score)
      bestOff = offsetMs
    }
  }
  return { bpm: bestBpm, offsetMs: bestOff }
}

/** Grid-fit score at a BPM (higher = onsets land on that beat). */
export function tempoGridScore(
  samples: Float32Array,
  sampleRate: number,
  bpm: number
): { onset: number; bass: number } {
  const resampled = resampleMonoPcm(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const pcm = peakNormalize(resampled, peakOf(resampled))
  const hop = 512
  const hopMs = (hop / ANALYSIS_SAMPLE_RATE) * 1000
  const flux = spectralFlux(pcm, 2048, hop)
  const energyFrames = frameEnergy(pcm, hop)
  const novelty = combineNovelty(flux, energyNovelty(energyFrames))
  const bassNov = energyNovelty(frameEnergy(onePoleLowpass(pcm), hop))
  const beatMs = 60000 / Math.max(60, bpm)
  const steps = Math.max(4, Math.round(beatMs / hopMs))
  let best = 0
  let bestBass = 0
  for (let s = 0; s < steps; s++) {
    const score = meanNoveltyOnGrid(novelty, hopMs, beatMs, s * hopMs)
    const bass = meanNoveltyOnGrid(bassNov, hopMs, beatMs, s * hopMs)
    if (score > best) best = score
    if (bass > bestBass) bestBass = bass
  }
  return { onset: best, bass: bestBass }
}

function onePoleLowpass(samples: Float32Array, alpha = 0.045): Float32Array {
  const out = new Float32Array(samples.length)
  let y = 0
  for (let i = 0; i < samples.length; i++) {
    y += alpha * (samples[i] - y)
    out[i] = y
  }
  return out
}

/** Prefer kick phase over snare (half-beat) using low-frequency novelty. */
function pickKickPhase(
  bassNovelty: Float32Array,
  hopMs: number,
  bpm: number,
  offsetMs: number
): number {
  const beatMs = 60000 / bpm
  const wrap = (ms: number) => ((ms % beatMs) + beatMs) % beatMs
  const a = wrap(offsetMs)
  const b = wrap(offsetMs + beatMs / 2)
  const sa = meanNoveltyOnGrid(bassNovelty, hopMs, beatMs, a)
  const sb = meanNoveltyOnGrid(bassNovelty, hopMs, beatMs, b)
  let chosen = sa >= sb ? a : b
  const best = Math.max(sa, sb)
  const worst = Math.min(sa, sb)
  if (worst >= best * 0.92) {
    chosen = a <= b ? a : b
  }
  const nearZero = a <= hopMs * 2 ? a : b <= hopMs * 2 ? b : chosen
  if (nearZero !== chosen) {
    const s0 = meanNoveltyOnGrid(bassNovelty, hopMs, beatMs, nearZero)
    if (s0 >= best * 0.9) chosen = nearZero
  }
  return chosen
}

/** Snap to a bar downbeat on the click grid (not mid-beat / mid-bar). */
export function snapToBarMs(
  ms: number,
  bpm: number,
  offsetMs: number,
  beatsPerBar = 4
): number {
  const beatMs = 60000 / Math.max(60, bpm)
  const barMs = beatMs * beatsPerBar
  const origin = Math.max(0, offsetMs)
  if (ms <= origin) return Math.round(origin)
  const n = Math.round((ms - origin) / barMs)
  return Math.round(origin + Math.max(0, n) * barMs)
}

function musicalSections(
  energyFrames: Float32Array,
  hopMs: number,
  durationMs: number,
  bpm: number,
  offsetMs: number
): SongSection[] {
  if (energyFrames.length === 0) {
    return [{ label: 'unknown', startMs: 0, energy: 0.5 }]
  }
  const beatMs = 60000 / Math.max(60, bpm)
  const barMs = beatMs * 4
  const phraseMs = barMs * 8
  const origin = Math.max(0, offsetMs)
  const maxE = Math.max(...energyFrames, 0.001)
  const chunks: { startMs: number; energy: number }[] = []
  for (let t = origin; t < durationMs; t += phraseMs) {
    if (durationMs - t < barMs * 2 && chunks.length > 0) break
    const startFrame = Math.max(0, Math.round(t / hopMs))
    const endFrame = Math.min(energyFrames.length, Math.round((t + phraseMs) / hopMs))
    if (endFrame <= startFrame) break
    let sum = 0
    for (let j = startFrame; j < endFrame; j++) sum += energyFrames[j]
    chunks.push({
      startMs: Math.round(t),
      energy: sum / Math.max(1, endFrame - startFrame) / maxE
    })
  }
  const sorted = chunks.map((c) => c.energy).sort((a, b) => a - b)
  const p33 = sorted[Math.floor(sorted.length * 0.33)] ?? 0.35
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0.5
  const p66 = sorted[Math.floor(sorted.length * 0.66)] ?? 0.65
  const out: SongSection[] = []
  let highFlip = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    const tail = c.startMs > durationMs * 0.88
    const fading = tail && c.energy < p50
    let label: SongSectionLabel
    if (i === 0 && c.energy < p66) label = 'intro'
    else if (fading) label = 'outro'
    else if (c.energy >= p66) {
      highFlip++
      label = highFlip % 2 === 0 ? 'drop' : 'chorus'
    } else if (c.energy <= p33) label = tail ? 'outro' : 'verse'
    else label = c.energy >= p50 ? 'prechorus' : 'bridge'
    const prev = out[out.length - 1]
    if (prev && prev.label === label) continue
    if (prev && prev.label === 'outro' && label === 'outro') continue
    out.push({
      label,
      startMs: c.startMs,
      energy: Math.round(c.energy * 1000) / 1000
    })
  }
  return out.length ? out : [{ label: 'unknown', startMs: 0, energy: 0.5 }]
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

/** Known-title tempos when the onset grid prefers a slower alias (e.g. 129 vs 169). */
export function tempoHintForTitle(title: string): number | undefined {
  const t = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (/\btake on me\b/.test(t)) return 169
  return undefined
}

function bestOffsetForBpm(novelty: Float32Array, hopMs: number, bpm: number): number {
  const beatMs = 60000 / bpm
  const steps = Math.max(4, Math.round(beatMs / hopMs))
  let bestOff = 0
  let bestOffScore = -1
  for (let s = 0; s < steps; s++) {
    const offsetMs = s * hopMs
    const score = meanNoveltyOnGrid(novelty, hopMs, beatMs, offsetMs)
    const closer = offsetMs < bestOff && score >= bestOffScore * 0.985
    if (score > bestOffScore || closer) {
      bestOffScore = Math.max(bestOffScore, score)
      bestOff = offsetMs
    }
  }
  return bestOff
}

/**
 * Analyze mono PCM (float -1..1). Returns BPM, beat grid, and section map.
 */
export function analyzeMonoPcm(
  samples: Float32Array,
  sampleRate: number,
  durationMsOverride?: number,
  bpmOverride?: number
): SongAudioAnalysis {
  const resampled = resampleMonoPcm(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const peak = peakOf(resampled)
  const pcm = peakNormalize(resampled, peak)
  const durationMs =
    durationMsOverride ?? Math.round((pcm.length / ANALYSIS_SAMPLE_RATE) * 1000)

  const frameSize = 2048
  const hop = 512
  const hopMs = (hop / ANALYSIS_SAMPLE_RATE) * 1000

  const flux = spectralFlux(pcm, frameSize, hop)
  const energyFrames = frameEnergy(pcm, hop)
  const novelty = combineNovelty(flux, energyNovelty(energyFrames))
  const override =
    bpmOverride && Number.isFinite(bpmOverride) && bpmOverride >= 60 && bpmOverride <= 240
      ? Math.round(bpmOverride)
      : undefined
  let bpm: number
  let rawOff: number
  if (override) {
    bpm = override
    rawOff = bestOffsetForBpm(novelty, hopMs, bpm)
  } else {
    const tracked = trackTempoAndPhase(novelty, hopMs)
    bpm = tracked.bpm
    rawOff = tracked.offsetMs
  }
  const bassNov = energyNovelty(frameEnergy(onePoleLowpass(pcm), hop))
  const offsetMs = pickKickPhase(bassNov, hopMs, bpm, rawOff)
  const beatTimesMs = buildBeatGrid(durationMs, bpm, offsetMs)
  const sections = musicalSections(energyFrames, hopMs, durationMs, bpm, offsetMs)

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
