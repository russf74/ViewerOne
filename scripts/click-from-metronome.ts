/**
 * Rebuild a proper bar-accent click from a Moises metronome WAV (same hit times).
 * Looks in the renders folder for *metronome* / *moises* / *-metronome.wav
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeClickTrackWav } from '../src/main/clickTrackWav.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'
import {
  medianBpmFromOnsets,
  metronomeOnsetsMs,
  pickDownbeatPhase
} from '../src/shared/metronomeOnsets.ts'
import type { SongAudioAnalysis } from '../src/shared/audioAnalysis.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

const rendersDir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
const capturePath = path.join(rendersDir, '006-pc4-take-on-me.wav')
const clickPath = path.join(rendersDir, '007-pc4-take-on-me-click.wav')

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

function findMetronome(): string | undefined {
  const arg = process.argv[2]
  if (arg && fs.existsSync(arg)) return arg
  const sidecar = path.join(rendersDir, '006-pc4-take-on-me-metronome.wav')
  if (fs.existsSync(sidecar)) return sidecar
  if (!fs.existsSync(rendersDir)) return undefined
  return fs
    .readdirSync(rendersDir)
    .filter((n) => /\.wav$/i.test(n) && /metronome|moises/i.test(n) && !/-click/i.test(n))
    .map((n) => path.join(rendersDir, n))
    .find((p) => fs.existsSync(p))
}

const metroPath = findMetronome()
if (!metroPath) {
  console.error('No Moises metronome WAV found. Put it next to the capture as 006-pc4-take-on-me-metronome.wav')
  process.exit(1)
}

const metro = await decode48k(metroPath)
const onsets = metronomeOnsetsMs(metro, 48000)
if (onsets.length < 8) {
  console.error('Could not read clicks from metronome', metroPath, 'onsets', onsets.length)
  process.exit(1)
}
const song = fs.existsSync(capturePath) ? await decode48k(capturePath) : undefined
const accentPhase = pickDownbeatPhase(onsets, song, 48000)
const bpm = medianBpmFromOnsets(onsets)
const durationMs = (metro.length / 48000) * 1000
const analysis: SongAudioAnalysis = {
  analyzedAt: new Date().toISOString(),
  durationMs,
  sampleRate: 48000,
  bpm,
  beatOffsetMs: onsets[0] ?? 0,
  beatTimesMs: onsets.slice(0, 512).map((t) => Math.round(t)),
  clickBeatsMs: onsets,
  sections: [],
  peakEnergy: 0.5
}

const written = writeClickTrackWav(clickPath, analysis, {
  countInBars: 0,
  embedCountIn: true,
  accentEvery: 4,
  accentPhase,
  sampleRate: 48000,
  durationSamples: metro.length
})

const iv = onsets.slice(1).map((t, i) => t - onsets[i]!)
iv.sort((a, b) => a - b)
console.log({
  from: metroPath,
  click: clickPath,
  bpm,
  onsets: onsets.length,
  firstMs: onsets[0],
  accentPhase,
  periodMs: { min: iv[0], med: iv[Math.floor(iv.length / 2)], max: iv[iv.length - 1] },
  durationMs,
  countInMs: written.countInMs
})

if (fs.existsSync(configPath)) {
  const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { setlist: Array<Record<string, unknown>> }
  const songRow = j.setlist.find((s) => String(s.title) === 'Take on me')
  if (songRow) {
    const lighting = buildLightingProgram(analysis)
    songRow.audioAnalysis = analysis
    songRow.lightingProgram = lighting
    songRow.clickTrackPath = clickPath
    songRow.clickTrackCountInMs = written.countInMs
    fs.writeFileSync(configPath, JSON.stringify(j, null, '\t') + '\n')
    console.log('patched Take on me in config')
  }
}

console.log('OK bar-accent click from Moises metronome')
