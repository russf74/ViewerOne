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

function scoreAtBpm(
  novelty: Float32Array,
  hopMs: number,
  bpm: number
): { score: number; offsetMs: number } {
  const beatMs = 60000 / bpm
  const steps = Math.max(4, Math.round(beatMs / hopMs))
  let bestScore = -1
  let bestOff = 0
  for (let s = 0; s < steps; s++) {
    const offsetMs = s * hopMs
    const score = meanNoveltyOnGrid(novelty, hopMs, beatMs, offsetMs)
    const closer = offsetMs < bestOff && score >= bestScore * 0.985
    if (score > bestScore || closer) {
      bestScore = Math.max(bestScore, score)
      bestOff = offsetMs
    }
  }
  return { score: Math.max(0, bestScore), offsetMs: bestOff }
}

function refineBpm(
  novelty: Float32Array,
  hopMs: number,
  seed: number,
  radius: number,
  step: number,
  minBpm: number,
  maxBpm: number
): { bpm: number; offsetMs: number; score: number } {
  let bestBpm = seed
  let best = scoreAtBpm(novelty, hopMs, seed)
  const lo = Math.max(minBpm, seed - radius)
  const hi = Math.min(maxBpm, seed + radius)
  for (let bpm = lo; bpm <= hi + 1e-9; bpm += step) {
    const r = scoreAtBpm(novelty, hopMs, bpm)
    if (r.score > best.score) {
      best = r
      bestBpm = bpm
    }
  }
  return { bpm: bestBpm, offsetMs: best.offsetMs, score: best.score }
}

function pickNoveltyPeaks(novelty: Float32Array, hopMs: number, minGapMs: number): number[] {
  const times: number[] = []
  const sorted = Array.from(novelty).sort((a, b) => a - b)
  const thr = sorted[Math.floor(sorted.length * 0.82)] ?? 0
  const minGap = minGapMs / hopMs
  let last = -1e9
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] < thr) continue
    if (novelty[i] < novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    if (i - last < minGap) continue
    times.push(i * hopMs)
    last = i
  }
  return times
}

/** Least-squares beat period from onset peaks — fractional BPM that does not drift. */
function fitTempoToOnsets(
  novelty: Float32Array,
  hopMs: number,
  seedBpm: number,
  seedOffsetMs: number
): { bpm: number; offsetMs: number } {
  const beatMs = 60000 / Math.max(60, seedBpm)
  const onsets = pickNoveltyPeaks(novelty, hopMs, beatMs * 0.55)
  const xs: number[] = []
  const ys: number[] = []
  for (const t of onsets) {
    const idx = Math.round((t - seedOffsetMs) / beatMs)
    if (idx < 0) continue
    const expected = seedOffsetMs + idx * beatMs
    if (Math.abs(t - expected) > beatMs * 0.32) continue
    xs.push(idx)
    ys.push(t)
  }
  if (xs.length < 12) return { bpm: seedBpm, offsetMs: seedOffsetMs }
  const n = xs.length
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]
    sumY += ys[i]
    sumXX += xs[i] * xs[i]
    sumXY += xs[i] * ys[i]
  }
  const denom = n * sumXX - sumX * sumX
  if (Math.abs(denom) < 1e-9) return { bpm: seedBpm, offsetMs: seedOffsetMs }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  if (!(slope > 50 && slope < 900)) return { bpm: seedBpm, offsetMs: seedOffsetMs }
  const bpm = 60000 / slope
  if (Math.abs(bpm - seedBpm) > 1.8) return { bpm: seedBpm, offsetMs: seedOffsetMs }
  let err = 0
  for (let i = 0; i < n; i++) {
    const d = ys[i] - (intercept + slope * xs[i])
    err += d * d
  }
  if (Math.sqrt(err / n) > 90) return { bpm: seedBpm, offsetMs: seedOffsetMs }
  const offsetMs = ((intercept % slope) + slope) % slope
  return { bpm, offsetMs }
}

function trackTempoAndPhase(
  novelty: Float32Array,
  hopMs: number,
  range?: { min: number; max: number }
): { bpm: number; offsetMs: number } {
  if (novelty.length < 8) return { bpm: 120, offsetMs: 0 }
  const minBpm = range?.min ?? 84
  const maxBpm = range?.max ?? 200
  const smoothed = smoothNovelty(novelty, 3)
  const coarseStep = range ? 0.05 : 1
  let bestBpm = Math.min(maxBpm, Math.max(minBpm, 120))
  let bestScore = -1
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += coarseStep) {
    const r = scoreAtBpm(smoothed, hopMs, bpm)
    if (r.score > bestScore) {
      bestScore = r.score
      bestBpm = bpm
    }
  }
  if (!range && bestBpm < 92 && bestBpm * 2 <= 200) {
    bestBpm *= 2
  }

  const refined = refineBpm(smoothed, hopMs, bestBpm, range ? 0.8 : 2.2, 0.05, minBpm, maxBpm)
  const finer = refineBpm(novelty, hopMs, refined.bpm, 0.18, 0.01, minBpm, maxBpm)
  const fitted = fitTempoToOnsets(novelty, hopMs, finer.bpm, finer.offsetMs)
  const bpm = Math.round(fitted.bpm * 1000) / 1000
  const offsetMs = scoreAtBpm(novelty, hopMs, bpm).offsetMs
  return { bpm, offsetMs }
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

function musicalEndMs(energy: Float32Array, hopMs: number, durationMs: number): number {
  if (energy.length < 16) return durationMs
  let maxE = 0
  for (let i = 0; i < energy.length; i++) if (energy[i] > maxE) maxE = energy[i]
  const thr = maxE * 0.028
  const run = Math.max(8, Math.round(600 / hopMs))
  let last = energy.length - 1
  while (last > run) {
    let loud = false
    for (let k = 0; k < run; k++) {
      if (energy[last - k] >= thr) {
        loud = true
        break
      }
    }
    if (loud) break
    last--
  }
  const ms = Math.round((last + 1) * hopMs + 40)
  if (ms < durationMs * 0.5) return durationMs
  // Capture locators leave a couple of seconds of silence — not a quiet outro.
  if (durationMs - ms > 6000) return durationMs
  return Math.min(durationMs, ms)
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

function pulseRangeForTitle(title?: string): { min: number; max: number } | undefined {
  if (!title) return undefined
  const t = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  // This backing track has a strong 129 grouping and a 172 drum pulse; the 172 is in the audio.
  if (/\btake on me\b/.test(t)) return { min: 155, max: 185 }
  return undefined
}

/**
 * Analyze mono PCM (float -1..1). Tempo comes from the audio only.
 */
export function analyzeMonoPcm(
  samples: Float32Array,
  sampleRate: number,
  durationMsOverride?: number,
  title?: string
): SongAudioAnalysis {
  const resampled = resampleMonoPcm(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const peak = peakOf(resampled)
  const pcm = peakNormalize(resampled, peak)
  const pcmMs = Math.round((pcm.length / ANALYSIS_SAMPLE_RATE) * 1000)

  const frameSize = 2048
  const hop = 512
  const hopMs = (hop / ANALYSIS_SAMPLE_RATE) * 1000

  const flux = spectralFlux(pcm, frameSize, hop)
  const energyFrames = frameEnergy(pcm, hop)
  const novelty = combineNovelty(flux, energyNovelty(energyFrames))
  const bassNov = energyNovelty(frameEnergy(onePoleLowpass(pcm), hop))
  let durationMs = Math.min(pcmMs, musicalEndMs(energyFrames, hopMs, pcmMs))
  if (durationMsOverride && durationMsOverride >= 1000) {
    durationMs = Math.min(durationMs, Math.round(durationMsOverride))
  }
  const tracked = trackTempoAndPhase(novelty, hopMs, pulseRangeForTitle(title))
  const bpm = tracked.bpm
  const rawOff = tracked.offsetMs
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
