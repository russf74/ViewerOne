/** Click track synthesis — pure functions for IEM / rehearsal. */

import type { SongAudioAnalysis } from './audioAnalysis.js'

export type ClickTrackOptions = {
  /** Regular click level 0–1. */
  volume?: number
  /** Downbeat accent level 0–1. */
  accentVolume?: number
  /** Accent every N beats (4 = bar downbeat in 4/4). */
  accentEvery?: number
  /** Bars of count-in before t=0 (WAV only). */
  countInBars?: number
  /** Assumed 4/4 — beats per bar for count-in. */
  beatsPerBar?: number
  sampleRate?: number
  /** Short click length in ms. */
  clickMs?: number
  /** Accent click length in ms. */
  accentClickMs?: number
  /** If set, click WAV lasts this long (ms) instead of analysis.durationMs. */
  durationMs?: number
  /** Exact output PCM frames (wins over durationMs when > 0). */
  durationSamples?: number
  /**
   * If true (default), the 4 count-in beeps replace the first 4 song beats so the
   * WAV is the same length as the audio. If false, beeps are prepended (extra time).
   */
  embedCountIn?: boolean
}

const DEFAULT_OPTS: Required<ClickTrackOptions> = {
  volume: 0.55,
  accentVolume: 0.95,
  accentEvery: 4,
  countInBars: 1,
  beatsPerBar: 4,
  sampleRate: 48000,
  clickMs: 8,
  accentClickMs: 12,
  durationMs: 0,
  durationSamples: 0,
  embedCountIn: true
}

/** Full beat grid for click generation (not storage-capped). */
export function buildFullBeatGrid(analysis: SongAudioAnalysis): number[] {
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const beats: number[] = []
  let t = Math.max(0, analysis.beatOffsetMs)
  while (t <= analysis.durationMs) {
    beats.push(Math.round(t))
    t += beatMs
    if (beats.length > 10000) break
  }
  return beats
}

/** Beat times including optional count-in. Embedded (default): first N song beats are beeps. */
export function beatTimesWithCountIn(
  analysis: SongAudioAnalysis,
  countInBars: number,
  beatsPerBar = 4,
  untilMs = 0,
  embedCountIn = true
): { atMs: number; accent: boolean; beatIndex: number; countIn: boolean }[] {
  const opts = { ...DEFAULT_OPTS, countInBars, beatsPerBar, embedCountIn }
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const firstDownbeat = Math.max(0, analysis.beatOffsetMs)
  const countInBeats = countInBars * beatsPerBar
  const out: { atMs: number; accent: boolean; beatIndex: number; countIn: boolean }[] = []
  const endMs = Math.max(analysis.durationMs, untilMs)
  const tracked = analysis.clickBeatsMs?.filter((t) => t >= 0 && t <= endMs)

  if (tracked && tracked.length >= 8) {
    const countInBeats = countInBars * beatsPerBar
    return tracked.map((atMs, beatIndex) => ({
      atMs,
      accent: beatIndex % opts.accentEvery === 0,
      beatIndex,
      countIn: opts.embedCountIn && beatIndex < countInBeats
    }))
  }

  if (opts.embedCountIn) {
    let beatIndex = 0
    while (out.length < 12000) {
      const t = firstDownbeat + beatIndex * beatMs
      if (t > endMs) break
      out.push({
        atMs: t,
        accent: beatIndex % opts.accentEvery === 0,
        beatIndex,
        countIn: beatIndex < countInBeats
      })
      beatIndex++
    }
    return out
  }

  let beatIndex = -countInBeats
  for (let i = 0; i < countInBeats; i++) {
    const atMs = firstDownbeat - (countInBeats - i) * beatMs
    out.push({
      atMs,
      accent: i === 0 || beatIndex % opts.accentEvery === 0,
      beatIndex,
      countIn: true
    })
    beatIndex++
  }
  let songBeat = 0
  while (out.length < 12000) {
    const t = firstDownbeat + songBeat * beatMs
    if (t > endMs) break
    out.push({
      atMs: t,
      accent: beatIndex % opts.accentEvery === 0,
      beatIndex,
      countIn: false
    })
    beatIndex++
    songBeat++
  }
  return out
}

function synthesizeClickSample(
  sampleRate: number,
  durationMs: number,
  freqHz: number,
  volume: number
): Float32Array {
  const len = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate
    const env = Math.exp(-t * 80)
    out[i] = Math.sin(2 * Math.PI * freqHz * t) * env * volume
  }
  return out
}

/** Mix click events into a mono PCM buffer (includes count-in at negative times shifted to start). */
export function synthesizeClickTrack(
  analysis: SongAudioAnalysis,
  options: ClickTrackOptions = {}
): { samples: Float32Array; sampleRate: number; countInMs: number } {
  const opts = { ...DEFAULT_OPTS, ...options }
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const firstDownbeat = Math.max(0, analysis.beatOffsetMs)
  const countInBeats = opts.countInBars * opts.beatsPerBar
  const firstBeepAt = firstDownbeat - countInBeats * beatMs
  const countInMs = opts.embedCountIn
    ? 0
    : Math.max(0, Math.round(-Math.min(0, firstBeepAt)))
  const songMs = Math.max(analysis.durationMs, opts.durationMs ?? 0)
  const totalMs = countInMs + songMs
  const sampleRate = opts.sampleRate
  const totalSamples =
    opts.durationSamples > 0 ? opts.durationSamples : Math.round((totalMs / 1000) * sampleRate)
  const mix = new Float32Array(totalSamples)

  const regular = synthesizeClickSample(sampleRate, opts.clickMs, 1800, opts.volume)
  const accent = synthesizeClickSample(sampleRate, opts.accentClickMs, 2400, opts.accentVolume)
  const beep = synthesizeClickSample(sampleRate, 45, 1000, Math.min(1, opts.accentVolume + 0.05))
  const beepDown = synthesizeClickSample(sampleRate, 55, 780, 1)

  const tracked = analysis.clickBeatsMs?.filter((t) => t >= 0)
  const useSampleGrid = !(tracked && tracked.length >= 8)

  const mixClick = (startSample: number, countIn: boolean, accentHit: boolean): void => {
    if (startSample < 0 || startSample >= mix.length) return
    const click = countIn ? (accentHit ? beepDown : beep) : accentHit ? accent : regular
    for (let i = 0; i < click.length && startSample + i < mix.length; i++) {
      mix[startSample + i] += click[i]!
    }
  }

  if (useSampleGrid) {
    const origin = (firstDownbeat / 1000) * sampleRate
    const periodSamples = (60 * sampleRate) / Math.max(60, analysis.bpm)
    for (let i = 0; ; i++) {
      const startSample = Math.round(origin + i * periodSamples)
      if (startSample >= mix.length) break
      mixClick(startSample, opts.embedCountIn && i < countInBeats, i % opts.accentEvery === 0)
    }
  } else {
    const clipMs = (totalSamples / sampleRate) * 1000 - countInMs
    const events = beatTimesWithCountIn(
      analysis,
      opts.countInBars,
      opts.beatsPerBar,
      Math.max(songMs, clipMs),
      opts.embedCountIn
    )
    for (const ev of events) {
      const offsetMs = ev.atMs + countInMs
      mixClick(Math.round((offsetMs / 1000) * sampleRate), ev.countIn, ev.accent)
    }
  }

  // Soft limit
  for (let i = 0; i < mix.length; i++) {
    mix[i] = Math.tanh(mix[i] * 1.2)
  }

  return { samples: mix, sampleRate, countInMs }
}

/** Index of the last beat at or before `performanceMs`. */
export function beatIndexAt(analysis: SongAudioAnalysis, performanceMs: number): number {
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const offset = Math.max(0, analysis.beatOffsetMs)
  if (performanceMs < offset) return -1
  return Math.floor((performanceMs - offset) / beatMs)
}

/** Ms of beat `index` from song start (0-based, excluding count-in). */
export function beatMsForIndex(analysis: SongAudioAnalysis, index: number): number {
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  return Math.round(analysis.beatOffsetMs + index * beatMs)
}
