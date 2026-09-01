import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { beatTimesWithCountIn, synthesizeClickTrack } from '../src/shared/clickTrack.ts'
import {
  medianBpmFromOnsets,
  metronomeOnsetsMs,
  pickDownbeatPhase
} from '../src/shared/metronomeOnsets.ts'
import { parseBeatMapJson } from '../src/shared/beatMapParse.ts'

function clickTrackPcm(bpm: number, durationSec: number, sr = 22050): Float32Array {
  const n = Math.floor(durationSec * sr)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  const clickLen = Math.floor(sr * 0.01)
  for (let b = 0; b * beatSec < durationSec; b++) {
    const start = Math.floor(b * beatSec * sr)
    for (let i = 0; i < clickLen && start + i < n; i++) {
      out[start + i] = Math.sin((2 * Math.PI * 1000 * i) / sr)
    }
  }
  return out
}

const analysis = analyzeMonoPcm(clickTrackPcm(120, 10), 22050)
const cubase = synthesizeClickTrack(analysis, { countInBars: 1, sampleRate: 48000 })
if (cubase.sampleRate !== 48000) throw new Error(`expected 48 kHz click, got ${cubase.sampleRate}`)
if (cubase.countInMs !== 0) throw new Error(`embedded beeps must not extend the WAV, got ${cubase.countInMs}`)
const wavMs = (cubase.samples.length / cubase.sampleRate) * 1000
if (Math.abs(wavMs - analysis.durationMs) > 40) {
  throw new Error(`WAV ${wavMs} != song ${analysis.durationMs}`)
}
const events = beatTimesWithCountIn(analysis, 1, 4)
const beeps = events.filter((e) => e.countIn)
if (beeps.length !== 4) throw new Error(`expected 4 count-in beeps, got ${beeps.length}`)
if (beeps.some((e) => e.atMs < 0)) throw new Error('embedded beeps must not start before t=0')
const firstSong = events.find((e) => !e.countIn)
if (!firstSong) throw new Error('missing first song click')
const beepToClick = firstSong.atMs - beeps[0].atMs
const fourBeats = 4 * (60000 / Math.max(60, analysis.bpm))
if (Math.abs(beepToClick - fourBeats) > 40) {
  throw new Error(`4 beeps should span ${fourBeats}ms, got ${beepToClick}`)
}
const exact = synthesizeClickTrack(analysis, { countInBars: 1, sampleRate: 48000, durationSamples: 123456 })
if (exact.samples.length !== 123456) {
  throw new Error(`durationSamples not honoured: ${exact.samples.length}`)
}
const stretched = synthesizeClickTrack(analysis, { countInBars: 1, durationMs: 226000 })
const stretchedMs = Math.round((stretched.samples.length / stretched.sampleRate) * 1000)
if (Math.abs(stretchedMs - 226000) > 40) throw new Error(`expected 226000 ms WAV, got ${stretchedMs}`)
const prepended = synthesizeClickTrack(analysis, { countInBars: 1, embedCountIn: false })
if (prepended.countInMs <= 0) throw new Error('prepended count-in missing from WAV')
if (prepended.samples.length <= cubase.samples.length) {
  throw new Error('prepended WAV should be longer than embedded')
}

function rmsAt(pcm: Float32Array, sr: number, tMs: number, winMs = 12): number {
  const c = Math.round((tMs / 1000) * sr)
  const w = Math.round((winMs / 1000) * sr)
  let s = 0
  let n = 0
  for (let i = c; i < c + w && i < pcm.length; i++) {
    s += pcm[i]! * pcm[i]!
    n++
  }
  return n ? Math.sqrt(s / n) : 0
}

const metroTimes = Array.from({ length: 32 }, (_, i) => i * 500)
const metroPcm = new Float32Array(48000 * 16)
for (const t of metroTimes) {
  const start = Math.round((t / 1000) * 48000)
  for (let i = 0; i < 200 && start + i < metroPcm.length; i++) {
    metroPcm[start + i] = Math.sin((2 * Math.PI * 1000 * i) / 48000) * Math.exp(-i / 40)
  }
}
const onsets = metronomeOnsetsMs(metroPcm, 48000)
if (onsets.length < 28) throw new Error(`expected ~32 metronome hits, got ${onsets.length}`)
for (let i = 0; i < 16; i++) {
  if (Math.abs(onsets[i]! - metroTimes[i]!) > 4) {
    throw new Error(`onset ${i} ${onsets[i]} != ${metroTimes[i]}`)
  }
}
if (Math.abs(medianBpmFromOnsets(onsets) - 120) > 1) {
  throw new Error(`metronome BPM expected ~120, got ${medianBpmFromOnsets(onsets)}`)
}

const fromMetro = synthesizeClickTrack(
  {
    analyzedAt: '',
    durationMs: 16000,
    sampleRate: 48000,
    bpm: 120,
    beatOffsetMs: onsets[0]!,
    beatTimesMs: onsets.map((t) => Math.round(t)),
    clickBeatsMs: onsets,
    sections: [],
    peakEnergy: 0.5
  },
  { countInBars: 0, embedCountIn: false, accentEvery: 4, accentPhase: 0, sampleRate: 48000, durationSamples: metroPcm.length }
)
const down = rmsAt(fromMetro.samples, 48000, onsets[0]!)
const two = rmsAt(fromMetro.samples, 48000, onsets[1]!)
if (!(down > two * 1.2)) {
  throw new Error(`downbeat should be louder than beat 2, got ${down} vs ${two}`)
}
const phase1 = synthesizeClickTrack(
  {
    analyzedAt: '',
    durationMs: 16000,
    sampleRate: 48000,
    bpm: 120,
    beatOffsetMs: onsets[0]!,
    beatTimesMs: onsets.map((t) => Math.round(t)),
    clickBeatsMs: onsets,
    sections: [],
    peakEnergy: 0.5
  },
  { countInBars: 0, embedCountIn: false, accentEvery: 4, accentPhase: 1, sampleRate: 48000, durationSamples: metroPcm.length }
)
const p1b1 = rmsAt(phase1.samples, 48000, onsets[0]!)
const p1b2 = rmsAt(phase1.samples, 48000, onsets[1]!)
if (!(p1b2 > p1b1 * 1.2)) {
  throw new Error(`accentPhase 1 should accent the second click, got ${p1b1} vs ${p1b2}`)
}
if (pickDownbeatPhase(onsets, undefined, 48000) !== 0) {
  throw new Error('no-song downbeat phase should be 0')
}
console.log('metronome resynth OK', { bpm: medianBpmFromOnsets(onsets), hits: onsets.length, down, two })

const mapped = parseBeatMapJson({
  bpm: 169.2,
  beats: [
    { start: 0.5, beat: 3 },
    { start: 0.854, beat: 4 },
    { start: 1.208, beat: 1 },
    { start: 1.562, beat: 2 }
  ]
})
if (Math.abs(mapped.timesMs[0]! - 500) > 1) throw new Error(`expected 500ms, got ${mapped.timesMs[0]}`)
if (mapped.accentPhase !== 2) throw new Error(`downbeat should be 3rd click, got phase ${mapped.accentPhase}`)
if (!mapped.fromBeatNumbers) throw new Error('expected beat numbers')
const secondsList = parseBeatMapJson([0, 0.5, 1, 1.5, 2])
if (Math.abs(secondsList.timesMs[1]! - 500) > 1) throw new Error('seconds list should scale to ms')
console.log('beat-map parse OK', mapped)

console.log('click-track: OK', {
  bpm: analysis.bpm,
  songMs: analysis.durationMs,
  wavMs: Math.round(wavMs),
  countInMs: cubase.countInMs,
  beeps: beeps.length,
  stretchedMs,
  sampleRate: cubase.sampleRate
})
