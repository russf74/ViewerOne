import {
  amplitudeToDbfs,
  measureAudioLevels,
  peakToMeterWidth
} from '../src/shared/audioLevel.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const silent = measureAudioLevels(new Float32Array(1024))
assert(silent.peak === 0 && silent.rms === 0, 'silence should be zero')
assert(amplitudeToDbfs(0) === -90, 'zero amp is floor')
assert(peakToMeterWidth(0) === 0, 'silence meter empty')

const full = new Float32Array([0, 1, -1, 0.5])
const hot = measureAudioLevels(full)
assert(hot.peak === 1, `full-scale peak, got ${hot.peak}`)
assert(Math.abs(amplitudeToDbfs(1)) < 1e-6, '0 dBFS')
assert(peakToMeterWidth(1) === 1, 'full-scale fills meter')

const quiet = new Float32Array(512).fill(0.001)
const q = measureAudioLevels(quiet)
assert(q.peak > 0 && q.peak < 0.01, 'quiet peak')
assert(peakToMeterWidth(q.peak) > 0 && peakToMeterWidth(q.peak) < 0.4, 'quiet still visible on dB scale')

console.log('audio-level: OK')
