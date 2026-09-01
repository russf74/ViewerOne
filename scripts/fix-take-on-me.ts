/**
 * Take On Me only: deep analysis, write click, verify duration matches the capture.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { synthesizeClickTrack } from '../src/shared/clickTrack.ts'
import { writeClickTrackWav } from '../src/main/clickTrackWav.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

const rendersDir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
const srcPath = path.join(rendersDir, 'pc4-take-on-me.wav')
const clickPath = path.join(rendersDir, 'pc4-take-on-me-click-match.wav')

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

function wavInfo(file: string): { sampleRate: number; channels: number; bits: number; dataBytes: number; samples: number; durationSec: number } {
  const buf = fs.readFileSync(file)
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
    off += 8 + size + (size % 2)
  }
  const samples = dataBytes / Math.max(1, channels * (bits / 8))
  return { sampleRate, channels, bits, dataBytes, samples, durationSec: samples / sampleRate }
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
  console.error('missing', srcPath)
  process.exit(1)
}

const header = wavInfo(srcPath)
console.log('SOURCE header', header)
console.log('SOURCE ffmpeg', await ffmpegDuration(srcPath))

const raw = await runFfmpeg([
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  srcPath,
  '-ac',
  '1',
  '-ar',
  '22050',
  '-f',
  'f32le',
  'pipe:1'
])
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const decodeSec = samples.length / 22050
console.log('decoded 22050 frames', samples.length, 'sec', decodeSec)

const asIs = analyzeMonoPcm(samples, 22050)
const fast = analyzeMonoPcm(samples, 22050, undefined, 'Take on me')
console.log('scan full-range', { bpm: asIs.bpm, offset: asIs.beatOffsetMs, durationMs: asIs.durationMs })
console.log('scan fast-band', { bpm: fast.bpm, offset: fast.beatOffsetMs, durationMs: fast.durationMs })

const exactMs = header.durationSec * 1000
console.log('exact source ms', exactMs)

const analysis = { ...fast, durationMs: exactMs }
if (fs.existsSync(clickPath)) fs.unlinkSync(clickPath)
const written = writeClickTrackWav(clickPath, analysis, {
  countInBars: 1,
  embedCountIn: true,
  accentEvery: 4,
  sampleRate: 48000,
  durationMs: exactMs
})
const synth = synthesizeClickTrack(analysis, {
  countInBars: 1,
  embedCountIn: true,
  sampleRate: 48000,
  durationMs: exactMs
})
const clickSec = synth.samples.length / synth.sampleRate
const clickHeader = wavInfo(clickPath)
console.log('CLICK header', clickHeader)
console.log('CLICK ffmpeg', await ffmpegDuration(clickPath))
console.log('CLICK samples', synth.samples.length, 'sec', clickSec)

const deltaMs = Math.abs(clickHeader.durationSec - header.durationSec) * 1000
console.log('DELTA ms', deltaMs)
if (deltaMs > 2) {
  throw new Error(`length mismatch: source ${header.durationSec}s vs click ${clickHeader.durationSec}s`)
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
  sourceSec: header.durationSec,
  clickSec: clickHeader.durationSec,
  clickFile: clickPath
})
