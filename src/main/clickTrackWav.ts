import fs from 'node:fs'
import type { SongAudioAnalysis } from '../shared/audioAnalysis.js'
import { synthesizeClickTrack, type ClickTrackOptions } from '../shared/clickTrack.js'

function writeWavFile(path: string, samples: Float32Array, sampleRate: number): void {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }

  fs.writeFileSync(path, buffer)
}

export type ClickTrackWriteResult = {
  path: string
  countInMs: number
  durationMs: number
  bpm: number
}

/** Write a stereo-ready mono WAV click track aligned to analyzed beats. */
export function writeClickTrackWav(
  path: string,
  analysis: SongAudioAnalysis,
  options: ClickTrackOptions = {}
): ClickTrackWriteResult {
  const { samples, sampleRate, countInMs } = synthesizeClickTrack(analysis, options)
  writeWavFile(path, samples, sampleRate)
  return {
    path,
    countInMs,
    durationMs: analysis.durationMs,
    bpm: analysis.bpm
  }
}
