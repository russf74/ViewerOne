/**
 * Take On Me only: click from the Cubase loopback capture, kicks locked beat-to-beat.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeMonoPcm, trackClickBeats } from '../src/shared/audioAnalysis.ts'
import { synthesizeClickTrack } from '../src/shared/clickTrack.ts'
import { writeClickTrackWav } from '../src/main/clickTrackWav.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

const rendersDir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
const srcPath = path.join(rendersDir, '001-pc4-take-on-me.wav')
const clickPath = path.join(rendersDir, '001-pc4-take-on-me-click.wav')

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('close', (code) => (code !== 0 ? reject(new Error(err || `ffmpeg ${code}`)) : resolve(Buffer.concat(chunks))))
  })
}

function wavInfo(file: string): {
  sampleRate: number
  channels: number
  bits: number
  frames: number
  durationSec: number
} {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(16384)
  fs.readSync(fd, buf, 0, 16384, 0)
  fs.closeSync(fd)
  let off = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let dataBytes = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    }
    if (id === 'data') {
      dataBytes = size
      break
    }
    if (!/^[A-Za-z0-9 ]{4}$/.test(id)) break
    off += 8 + size + (size % 2)
    if (off > 16000) break
  }
  const frameBytes = Math.max(1, channels * (bits / 8))
  const frames = dataBytes / frameBytes
  return { sampleRate, channels, bits, frames, durationSec: frames / sampleRate }
}

function ffmpegDuration(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-i', file, '-hide_banner', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('close', () => {
      const m = /Duration:\s*(\d+:\d+:\d+\.\d+)/.exec(err)
      const a = /Audio:.*,\s*(\d+) Hz/.exec(err)
      resolve(`${m?.[1] ?? '?'} @ ${a?.[1] ?? '?'} Hz`)
    })
    p.on('error', reject)
  })
}

if (!fs.existsSync(srcPath)) {
  console.error('missing capture', srcPath)
  process.exit(1)
}

const header = wavInfo(srcPath)
console.log('CAPTURE header', header)
console.log('CAPTURE ffmpeg', await ffmpegDuration(srcPath))

const raw = await runFfmpeg([
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  srcPath,
  '-ac',
  '1',
  '-ar',
  '48000',
  '-f',
  'f32le',
  'pipe:1'
])
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const locked = trackClickBeats(samples, 48000, { min: 166, max: 176 })
const named = analyzeMonoPcm(samples, 48000, undefined, 'Take on me')
console.log('kick-lock', {
  bpm: locked.bpm,
  offset: locked.offsetMs,
  durationMs: locked.durationMs,
  beats: locked.beatsMs.length,
  first: locked.beatsMs[0],
  last: locked.beatsMs[locked.beatsMs.length - 1]
})
console.log('analyze', { bpm: named.bpm, offset: named.beatOffsetMs, clickBeats: named.clickBeatsMs?.length })

const intervals = locked.beatsMs.slice(1).map((t, i) => t - locked.beatsMs[i]!)
intervals.sort((a, b) => a - b)
const mid = intervals[Math.floor(intervals.length / 2)] ?? 0
console.log('beat interval ms', {
  min: intervals[0],
  median: mid,
  max: intervals[intervals.length - 1],
  medianBpm: mid > 0 ? 60000 / mid : 0
})

if (mid > 0 && (intervals[intervals.length - 1]! - intervals[0]!) > 0.05) {
  throw new Error(
    `click must be a steady grid, interval range ${intervals[0]}–${intervals[intervals.length - 1]}`
  )
}

const exactMs = header.durationSec * 1000
const durationSamples = Math.round(header.frames * (48000 / header.sampleRate))
const analysis = {
  ...named,
  durationMs: exactMs,
  bpm: locked.bpm,
  beatOffsetMs: locked.offsetMs,
  clickBeatsMs: undefined
}

if (fs.existsSync(clickPath)) fs.unlinkSync(clickPath)
const written = writeClickTrackWav(clickPath, analysis, {
  countInBars: 1,
  embedCountIn: true,
  accentEvery: 4,
  sampleRate: 48000,
  durationMs: exactMs,
  durationSamples
})
const synth = synthesizeClickTrack(analysis, {
  countInBars: 1,
  embedCountIn: true,
  sampleRate: 48000,
  durationMs: exactMs,
  durationSamples
})
const clickHeader = wavInfo(clickPath)
console.log('CLICK header', clickHeader)
console.log('CLICK ffmpeg', await ffmpegDuration(clickPath))
console.log('CLICK samples', synth.samples.length)

const deltaMs = Math.abs(clickHeader.durationSec - header.durationSec) * 1000
console.log('DELTA ms', deltaMs)
if (deltaMs > 2) {
  throw new Error(`length mismatch: capture ${header.durationSec}s vs click ${clickHeader.durationSec}s`)
}

const lighting = buildLightingProgram(analysis)
if (fs.existsSync(configPath)) {
  const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { setlist: Array<Record<string, unknown>> }
  const song = j.setlist.find((s) => String(s.title) === 'Take on me')
  if (song) {
    song.audioAnalysis = analysis
    song.lightingProgram = lighting
    song.clickTrackPath = clickPath
    song.clickTrackCountInMs = written.countInMs
    fs.writeFileSync(configPath, JSON.stringify(j, null, '\t') + '\n')
    console.log('patched Take on me in config')
  }
}

console.log('OK Take On Me', {
  bpm: analysis.bpm,
  offsetMs: analysis.beatOffsetMs,
  captureSec: header.durationSec,
  clickSec: clickHeader.durationSec,
  clickFile: clickPath
})
