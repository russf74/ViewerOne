/**
 * Re-run analysis + lighting program for an existing Cubase render.
 * Patches viewer-one-config.json (Electron must be closed).
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(err || `ffmpeg exit ${code}`))
      else resolve(Buffer.concat(chunks))
    })
  })
}

const wav =
  process.argv[2] ||
  path.join(process.env.APPDATA ?? '', 'viewer-one', 'renders', 'pc3-let-me-entertain-you.wav')
const titleHint = process.argv[3] || 'Let me entertain you'

if (!fs.existsSync(wav)) {
  console.error('missing wav', wav)
  process.exit(1)
}

const raw = await runFfmpeg([
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  wav,
  '-ac',
  '1',
  '-ar',
  '22050',
  '-f',
  'f32le',
  'pipe:1'
])
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const analysis = analyzeMonoPcm(samples, 22050, undefined, titleHint)
const program = buildLightingProgram(analysis)

const bases = program.cues.filter((c) => !c.accentDurationMs)
console.log(
  JSON.stringify(
    {
      bpm: analysis.bpm,
      offsetMs: Math.round(analysis.beatOffsetMs),
      durationMs: analysis.durationMs,
      peakEnergy: analysis.peakEnergy,
      sections: analysis.sections.map((s) => `${s.label}@${s.startMs}`),
      cues: bases.map(
        (c) =>
          `${c.atMs} ${c.label} esp${c.ledPatternId} stick${c.dmx?.stickPatternId} dome${c.dmx?.domePatternId}`
      )
    },
    null,
    2
  )
)

const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
if (fs.existsSync(configPath)) {
  const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    setlist: Array<Record<string, unknown>>
  }
  const song = j.setlist.find((s) => String(s.title) === titleHint)
  if (!song) {
    console.warn('config song not found:', titleHint)
  } else {
    song.audioAnalysis = analysis
    song.lightingProgram = program
    song.audioSource = 'cubase-render'
    song.cubaseRenderPath = wav
    song.cubaseRenderCapturedAt = new Date().toISOString()
    fs.writeFileSync(configPath, JSON.stringify(j, null, '\t') + '\n')
    console.log('patched', configPath)
  }
}
