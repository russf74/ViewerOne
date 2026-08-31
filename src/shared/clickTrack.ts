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
}

const DEFAULT_OPTS: Required<ClickTrackOptions> = {
  volume: 0.55,
  accentVolume: 0.95,
  accentEvery: 4,
  countInBars: 1,
  beatsPerBar: 4,
  sampleRate: 44100,
  clickMs: 8,
  accentClickMs: 12
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

/** Beat times including optional count-in (negative ms). */
export function beatTimesWithCountIn(
  analysis: SongAudioAnalysis,
  countInBars: number,
  beatsPerBar = 4
): { atMs: number; accent: boolean; beatIndex: number }[] {
  const opts = { ...DEFAULT_OPTS, countInBars, beatsPerBar }
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const countInBeats = countInBars * beatsPerBar
  const out: { atMs: number; accent: boolean; beatIndex: number }[] = []
  let beatIndex = -countInBeats
  for (let i = 0; i < countInBeats; i++) {
    const atMs = Math.round(-(countInBeats - i) * beatMs)
    out.push({ atMs, accent: beatIndex % opts.accentEvery === 0, beatIndex })
    beatIndex++
  }
  let t = Math.max(0, analysis.beatOffsetMs)
  while (t <= analysis.durationMs && out.length < 12000) {
    out.push({
      atMs: Math.round(t),
      accent: beatIndex % opts.accentEvery === 0,
      beatIndex
    })
    t += beatMs
    beatIndex++
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
  const countInMs = Math.round(
    opts.countInBars * opts.beatsPerBar * (60000 / Math.max(60, analysis.bpm))
  )
  const totalMs = countInMs + analysis.durationMs + 500
  const sampleRate = opts.sampleRate
  const totalSamples = Math.ceil((totalMs / 1000) * sampleRate)
  const mix = new Float32Array(totalSamples)

  const regular = synthesizeClickSample(sampleRate, opts.clickMs, 1800, opts.volume)
  const accent = synthesizeClickSample(sampleRate, opts.accentClickMs, 2400, opts.accentVolume)

  const events = beatTimesWithCountIn(analysis, opts.countInBars, opts.beatsPerBar)
  for (const ev of events) {
    const offsetMs = ev.atMs + countInMs
    if (offsetMs < 0) continue
    const startSample = Math.round((offsetMs / 1000) * sampleRate)
    const click = ev.accent ? accent : regular
    for (let i = 0; i < click.length && startSample + i < mix.length; i++) {
      mix[startSample + i] += click[i]
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
