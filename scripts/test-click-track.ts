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
const beeps = beatTimesWithCountIn(analysis, 1, 4).filter((e) => e.countIn)
if (beeps.length !== 4) throw new Error(`expected 4 count-in beeps, got ${beeps.length}`)
const firstSong = beatTimesWithCountIn(analysis, 1, 4).find((e) => !e.countIn)
if (!firstSong) throw new Error('missing first song click')
const beepToDownbeat = firstSong.atMs - beeps[0].atMs
const fourBeats = 4 * (60000 / Math.max(60, analysis.bpm))
if (Math.abs(beepToDownbeat - fourBeats) > 40) {
  throw new Error(`4 beeps should span ${fourBeats}ms before downbeat, got ${beepToDownbeat}`)
}
if (cubase.countInMs <= 0) throw new Error('count-in missing from WAV')
const songMs = (cubase.samples.length / cubase.sampleRate) * 1000 - cubase.countInMs
if (Math.abs(songMs - analysis.durationMs) > 40) {
  throw new Error(`song portion ${songMs} != ${analysis.durationMs}`)
}
const stretched = synthesizeClickTrack(analysis, { countInBars: 1, durationMs: 226000 })
const stretchedSong = Math.round((stretched.samples.length / stretched.sampleRate) * 1000 - stretched.countInMs)
if (Math.abs(stretchedSong - 226000) > 40) throw new Error(`expected 226000 ms song, got ${stretchedSong}`)
const withCount = synthesizeClickTrack(analysis, { countInBars: 2 })
if (withCount.countInMs <= cubase.countInMs) throw new Error('2-bar count-in should be longer')
console.log('click-track: OK', {
  bpm: analysis.bpm,
  songMs: analysis.durationMs,
  countInMs: cubase.countInMs,
  beeps: beeps.length,
  cubaseSongMs: stretchedSong,
  sampleRate: cubase.sampleRate
})
