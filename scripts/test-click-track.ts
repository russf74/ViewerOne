import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { beatTimesWithCountIn, synthesizeClickTrack } from '../src/shared/clickTrack.ts'

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
console.log('click-track: OK', {
  bpm: analysis.bpm,
  songMs: analysis.durationMs,
  wavMs: Math.round(wavMs),
  countInMs: cubase.countInMs,
  beeps: beeps.length,
  stretchedMs,
  sampleRate: cubase.sampleRate
})
