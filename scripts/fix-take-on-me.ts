/**
 * Take On Me only: click on the 48 kHz capture's own sample grid.
 * First kick → last kick, n whole beats, period = (last − first) / n samples.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeMonoPcm, TAKE_ON_ME_CUBASE_MS, trackClickBeats } from '../src/shared/audioAnalysis.ts'
import { writeClickTrackWav } from '../src/main/clickTrackWav.ts'
import { peakNormalizeWavFile } from '../src/main/wavNormalize.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

const rendersDir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
const srcPath =
  [
    path.join(rendersDir, '003-pc4-take-on-me.wav'),
    path.join(rendersDir, '004-pc4-take-on-me.wav'),
    path.join(rendersDir, '002-pc4-take-on-me.wav')
  ].find((p) => fs.existsSync(p)) ?? path.join(rendersDir, '004-pc4-take-on-me.wav')
const clickPath = path.join(rendersDir, '004-pc4-take-on-me-click.wav')
const captureOut = path.join(rendersDir, '004-pc4-take-on-me.wav')

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

async function decode48k(file: string): Promise<Float32Array> {
  const raw = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1'
  ])
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}

function clickOnsets(samples: Float32Array, sr: number): number[] {
  const hop = 64
  const times: number[] = []
  let last = -1e9
  const minGap = sr * 0.22
  for (let i = hop; i < samples.length - hop; i += hop) {
    let e = 0
    for (let k = 0; k < hop; k++) e += samples[i + k]! * samples[i + k]!
    if (e < 0.0008) continue
    if (i - last < minGap) continue
    times.push(i)
    last = i
  }
  return times
}

function kickEnergy(pcm: Float32Array, sr: number, tMs: number): number {
  const c = Math.round((tMs / 1000) * sr)
  const win = Math.round(sr * 0.02)
  let s = 0
  let n = 0
  for (let i = c - win; i <= c + win; i++) {
    if (i < 0 || i >= pcm.length) continue
    s += pcm[i]! * pcm[i]!
    n++
  }
  return n ? Math.sqrt(s / n) : 0
}

function reportLock(label: string, span: ReturnType<typeof trackClickBeats>, pcm: Float32Array, sr: number) {
  const last = span.originSample + span.n * span.periodSamples
  const spots = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.round(f * span.n)
    const tMs = ((span.originSample + i * span.periodSamples) / sr) * 1000
    return {
      frac: f,
      tMs: Math.round(tMs),
      on: Number(kickEnergy(pcm, sr, tMs).toFixed(4)),
      off: Number(kickEnergy(pcm, sr, tMs + 60000 / span.bpm / 2).toFixed(4))
    }
  })
  console.log(label, {
    bpm: span.bpm,
    n: span.n,
    originSample: span.originSample,
    periodSamples: span.periodSamples,
    firstMs: span.offsetMs,
    lastMs: (last / sr) * 1000,
    durationMs: span.durationMs,
    lock: spots
  })
}

if (!srcPath || !fs.existsSync(srcPath)) {
  console.error('missing capture', srcPath)
  process.exit(1)
}

if (srcPath !== captureOut) {
  fs.copyFileSync(srcPath, captureOut)
}
const gained = await peakNormalizeWavFile(captureOut)
console.log('GAIN', gained)

const header = wavInfo(captureOut)
console.log('CAPTURE', header)

const samples = await decode48k(captureOut)
const span = trackClickBeats(samples, 48000, { min: 166, max: 176 })
const named = analyzeMonoPcm(samples, 48000, (samples.length / 48000) * 1000, 'Take on me')
reportLock('native-span', span, samples, 48000)
console.log('analyze fields', {
  bpm: named.bpm,
  offset: named.beatOffsetMs,
  sampleRate: named.sampleRate,
  origin: named.clickOriginSample,
  period: named.clickPeriodSamples
})

const durationSamples = Math.round((TAKE_ON_ME_CUBASE_MS / 1000) * 48000)
const analysis = {
  ...named,
  durationMs: TAKE_ON_ME_CUBASE_MS,
  clickBeatsMs: undefined
}

for (const stale of fs.readdirSync(rendersDir)) {
  const p = path.join(rendersDir, stale)
  if (p !== captureOut) fs.unlinkSync(p)
}
const written = writeClickTrackWav(clickPath, analysis, {
  countInBars: 1,
  embedCountIn: true,
  accentEvery: 4,
  sampleRate: 48000,
  durationSamples
})
const clickHeader = wavInfo(clickPath)
console.log('CLICK', clickHeader)
console.log('DELTA ms', Math.abs(clickHeader.durationSec - header.durationSec) * 1000)

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
  origin: analysis.clickOriginSample,
  period: analysis.clickPeriodSamples,
  n: span.n,
  clickFile: clickPath
})
