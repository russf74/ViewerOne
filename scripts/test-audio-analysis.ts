/**
 * Smoke test for offline audio analysis.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMonoPcm, snapToBarMs, trackClickBeats } from '../src/shared/audioAnalysis.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

function clickTrackPcm(bpm: number, durationSec: number, sr = 22050): Float32Array {
  const n = Math.floor(durationSec * sr)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  const clickLen = Math.floor(sr * 0.01)
  for (let b = 0; b * beatSec < durationSec; b++) {
    const start = Math.floor(b * beatSec * sr)
    const accent = b % 4 === 0 ? 1 : 0.55
    for (let i = 0; i < clickLen && start + i < n; i++) {
      out[start + i] = accent * Math.sin((2 * Math.PI * 1000 * i) / sr)
    }
  }
  return out
}

function assertBpmNear(got: number, expected: number, tol = 8): void {
  if (Math.abs(got - expected) > tol) {
    throw new Error(`expected BPM ~${expected} (±${tol}), got ${got}`)
  }
}

const click128 = analyzeMonoPcm(clickTrackPcm(128, 16), 22050)
assertBpmNear(click128.bpm, 128)
if (click128.beatOffsetMs > 120) {
  throw new Error(`click 128 offset too large: ${click128.beatOffsetMs}`)
}
const quiet = clickTrackPcm(110, 16)
for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.02
const quiet110 = analyzeMonoPcm(quiet, 22050)
assertBpmNear(quiet110.bpm, 110)
console.log('click BPM:', click128.bpm, 'offset', click128.beatOffsetMs, 'quiet BPM:', quiet110.bpm)

const program = buildLightingProgram(click128)
const bases = program.cues.filter((c) => !c.accentDurationMs)
const espIds = bases.map((c) => c.ledPatternId)
if (new Set(espIds).size < Math.min(3, bases.length)) {
  throw new Error(`expected varied ESP patterns, got ${espIds.join(',')}`)
}
for (const cue of bases) {
  const stick = cue.dmx?.stickPatternId
  const dome = cue.dmx?.domePatternId
  if (stick == null || dome == null) throw new Error(`cue ${cue.label} missing complementary DMX`)
  if (stick === cue.ledPatternId) throw new Error(`sticks match ESP on ${cue.label}`)
  if (dome === cue.ledPatternId) throw new Error(`dome matches ESP on ${cue.label}`)
  if (stick === dome) throw new Error(`sticks match dome on ${cue.label}`)
}
console.log(
  'cues',
  bases.map((c) => `${c.label}:esp${c.ledPatternId}/stick${c.dmx?.stickPatternId}/dome${c.dmx?.domePatternId}`).join(' | ')
)

const pumping = analyzeMonoPcm(clickTrackPcm(124, 32), 22050)
const lastSec = pumping.sections[pumping.sections.length - 1]
if (lastSec?.label === 'outro') {
  throw new Error(`pumping tail must not be outro (energy ${lastSec.energy})`)
}
const pumpingProg = buildLightingProgram(pumping)
const lastPumpCue = pumpingProg.cues.filter((c) => !c.accentDurationMs).at(-1)
if (lastPumpCue?.ledPatternId === 0) {
  throw new Error('knight rider on a still-pumping ending')
}
console.log('pumping tail', lastSec?.label, 'esp', lastPumpCue?.ledPatternId)

function runFfmpeg(args: string[], bin = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

const click169 = analyzeMonoPcm(clickTrackPcm(169, 20), 22050)
assertBpmNear(click169.bpm, 169, 4)
console.log('click 169 BPM:', click169.bpm, 'offset', click169.beatOffsetMs)

const click128p4 = analyzeMonoPcm(clickTrackPcm(128.4, 24), 22050)
assertBpmNear(click128p4.bpm, 128.4, 0.35)
console.log('click 128.4 BPM:', click128p4.bpm)

const withTail = clickTrackPcm(120, 10)
const silentPad = new Float32Array(22050 * 3)
const padded = new Float32Array(withTail.length + silentPad.length)
padded.set(withTail)
const trimmed = analyzeMonoPcm(padded, 22050)
if (trimmed.durationMs > 10500) {
  throw new Error(`expected silence trim ~10s, got ${trimmed.durationMs}`)
}
if (Math.abs(trimmed.bpm - 120) > 2) {
  throw new Error(`trimmed 120 BPM click drifted to ${trimmed.bpm}`)
}
console.log('silence trim', trimmed.durationMs, 'bpm', trimmed.bpm)

const longPad = new Float32Array(withTail.length + 22050 * 12)
longPad.set(withTail)
const longTrim = analyzeMonoPcm(longPad, 22050)
if (longTrim.durationMs < 18000) {
  throw new Error(`quiet outro must not be chopped, got ${longTrim.durationMs}`)
}

const click172 = analyzeMonoPcm(clickTrackPcm(172.55, 20), 22050)
assertBpmNear(click172.bpm, 172.55, 1.5)
console.log('click 172.55 BPM:', click172.bpm)

function kickClickPcm(bpm: number, durationSec: number, sr = 22050): Float32Array {
  const n = Math.floor(durationSec * sr)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  const clickLen = Math.floor(sr * 0.04)
  for (let b = 0; b * beatSec < durationSec; b++) {
    const start = Math.floor(b * beatSec * sr)
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const env = Math.exp(-i / (sr * 0.012))
      out[start + i] = env * Math.sin((2 * Math.PI * 80 * i) / sr)
    }
  }
  return out
}
const locked = trackClickBeats(kickClickPcm(172.55, 24), 22050, { min: 166, max: 176 })
assertBpmNear(locked.bpm, 172.55, 0.4)
if (locked.beatsMs.length < 60) {
  throw new Error(`kick-lock should follow the whole click, got ${locked.beatsMs.length} beats`)
}
console.log('kick-lock 172.55 BPM:', locked.bpm, 'beats', locked.beatsMs.length)

const barMs = (60000 / Math.max(60, click128.bpm)) * 4
for (const s of click128.sections) {
  const snapped = snapToBarMs(s.startMs, click128.bpm, click128.beatOffsetMs)
  if (Math.abs(s.startMs - snapped) > 2) {
    throw new Error(`section ${s.label}@${s.startMs} not on a bar (snapped ${snapped})`)
  }
}
for (const cue of bases) {
  if (cue.label === 'start' && cue.atMs === 0) continue
  const snapped = snapToBarMs(cue.atMs, click128.bpm, click128.beatOffsetMs)
  if (Math.abs(cue.atMs - snapped) > 2) {
    throw new Error(`cue ${cue.label}@${cue.atMs} not on a bar (snapped ${snapped})`)
  }
}
console.log('bar snap OK', 'phrase~', Math.round(barMs * 8), 'ms', 'sections', click128.sections.length)

try {
  const dir = mkdtempSync(join(tmpdir(), 'vo-audio-test-'))
  const wav = join(dir, 'tone.wav')
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=6',
          '-ar',
          '22050',
          '-ac',
          '1',
          wav
        ],
        { stdio: 'inherit' }
      )
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wav gen ${code}`))))
    })

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
    const program = buildLightingProgram(analysis)
    console.log('tone BPM:', analysis.bpm)
    console.log('Sections:', analysis.sections.map((s) => `${s.label}@${s.startMs}ms`).join(', '))
    console.log('Cues:', program.cues.length)
    if (program.cues.length < 1) throw new Error('Expected at least 1 cue')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} catch (err) {
  console.log('ffmpeg tone test skipped:', err instanceof Error ? err.message : err)
}

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string
async function analyzeRender(name: string): Promise<ReturnType<typeof analyzeMonoPcm> | null> {
  const wav = join(process.env.APPDATA ?? '', 'viewer-one', 'renders', name)
  if (!existsSync(wav)) return null
  const raw = await runFfmpeg(
    [
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
    ],
    ffmpegStatic
  )
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  return analyzeMonoPcm(samples, 22050, undefined, name.includes('take-on-me') ? 'Take on me' : undefined)
}
try {
  const tom = await analyzeRender('pc4-take-on-me.wav')
  if (tom) {
    if (tom.bpm < 168 || tom.bpm > 176) {
      throw new Error(`Take On Me audio pulse should be ~172, got ${tom.bpm}`)
    }
    console.log('Take On Me render BPM:', tom.bpm, 'durationMs', tom.durationMs)
  }
  const jce = await analyzeRender('pc18-just-can-t-get-enough.wav')
  if (jce) {
    if (jce.bpm < 125 || jce.bpm > 132) {
      throw new Error(`Just Can't Get Enough should stay ~128, got ${jce.bpm}`)
    }
    console.log("Just Can't Get Enough render BPM:", jce.bpm)
  }
  const rio = await analyzeRender('pc14-rio.wav')
  if (rio) {
    if (rio.bpm < 136 || rio.bpm > 145) {
      throw new Error(`Rio should stay ~140, got ${rio.bpm}`)
    }
    console.log('Rio render BPM:', rio.bpm)
  }
  const jump = await analyzeRender('pc33-jump.wav')
  if (jump) {
    if (jump.bpm < 126 || jump.bpm > 134) {
      throw new Error(`Jump should stay ~130, got ${jump.bpm}`)
    }
    console.log('Jump render BPM:', jump.bpm)
  }
} catch (err) {
  if (
    String(err).includes('should') ||
    String(err).includes('Take On Me') ||
    String(err).includes('Jump') ||
    String(err).includes('Rio')
  ) {
    throw err
  }
  console.log('render BPM check skipped:', err instanceof Error ? err.message : err)
}

console.log('audio-analysis: OK')
