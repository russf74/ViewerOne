/**
 * Delete all click WAVs and rebuild from existing Cubase renders
 * (48 kHz, 4 count-in beeps, bar-aligned lighting).
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'
import { writeClickTrackWav } from '../src/main/clickTrackWav.ts'
import { songLengthSeconds } from '../src/shared/setlistTiming.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

const rendersDir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')

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

function slugTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function isPerformance(title: string, program: number): boolean {
  const t = title.toUpperCase()
  if (t.includes('SOUNDCHECK') || t.startsWith('INTRO') || t.startsWith('OUTRO')) return false
  return program >= 1 && program <= 119
}

function clickName(program: number, title: string): string {
  const slug = slugTitle(title)
  return `pc${program}${slug ? `-${slug}` : ''}-click-48khz.wav`
}

if (!fs.existsSync(configPath)) {
  console.error('missing config', configPath)
  process.exit(1)
}

for (const f of fs.readdirSync(rendersDir)) {
  if (/-click/i.test(f) && f.toLowerCase().endsWith('.wav')) {
    fs.unlinkSync(path.join(rendersDir, f))
    console.log('deleted', f)
  }
}

const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
  setlist: Array<Record<string, unknown>>
}

const rows = j.setlist.filter((s) => isPerformance(String(s.title ?? ''), Number(s.program) || 0))
const results: string[] = []

for (const song of rows) {
  const title = String(song.title ?? '')
  const program = Number(song.program) || 0
  const wav =
    (typeof song.cubaseRenderPath === 'string' && song.cubaseRenderPath) ||
    path.join(rendersDir, `pc${program}-${slugTitle(title)}.wav`)
  if (!fs.existsSync(wav)) {
    results.push(`SKIP PC${program} ${title} — no render`)
    continue
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
  const analysis = analyzeMonoPcm(samples, 22050)
  const programOut = buildLightingProgram(analysis)
  const listedMs = song.length ? songLengthSeconds(song.length) * 1000 : 0
  const durationMs = Math.max(analysis.durationMs, listedMs)
  const clickPath = path.join(rendersDir, clickName(program, title))
  const written = writeClickTrackWav(clickPath, analysis, {
    countInBars: 1,
    accentEvery: 4,
    sampleRate: 48000,
    durationMs
  })
  const bases = programOut.cues.filter((c) => !c.accentDurationMs)
  const barMs = (60000 / analysis.bpm) * 4
  const offBar = bases.filter((c) => {
    if (c.label === 'start' && c.atMs === 0) return false
    const n = (c.atMs - analysis.beatOffsetMs) / barMs
    return Math.abs(n - Math.round(n)) > 0.05
  })
  song.audioAnalysis = analysis
  song.lightingProgram = programOut
  song.clickTrackPath = clickPath
  song.clickTrackCountInMs = written.countInMs
  song.audioSource = 'cubase-render'
  song.cubaseRenderPath = wav
  const flag = offBar.length ? ' OFF-BAR' : ''
  results.push(
    `OK PC${program} ${title} ${analysis.bpm}bpm ${written.countInMs}ms-beeps ${bases.length}cues ${Math.round(durationMs / 1000)}s${flag}`
  )
  console.log(results[results.length - 1])
}

fs.writeFileSync(configPath, JSON.stringify(j, null, '\t') + '\n')
console.log('patched', configPath)
console.log('---')
for (const line of results) console.log(line)
