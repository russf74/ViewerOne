import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { synthesizeClickTrack } from '../src/shared/clickTrack.ts'

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
const aligned = synthesizeClickTrack(analysis, { countInBars: 0, sampleRate: 44100 })
const alignedMs = (aligned.samples.length / 44100) * 1000
if (Math.abs(alignedMs - analysis.durationMs) > 30) {
  throw new Error(`click WAV length ${alignedMs} != song ${analysis.durationMs}`)
}
if (aligned.countInMs !== 0) throw new Error('cubase click should have no count-in')
const withCount = synthesizeClickTrack(analysis, { countInBars: 2, sampleRate: 44100 })
if (withCount.countInMs <= 0) throw new Error('live count-in missing')
console.log('click-track: OK', {
  bpm: analysis.bpm,
  songMs: analysis.durationMs,
  clickMs: Math.round(alignedMs),
  liveCountInMs: withCount.countInMs
})
