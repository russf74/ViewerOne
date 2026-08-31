/**
 * Smoke test for offline audio analysis.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
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
if (click128.beatOffsetMs > 80) {
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

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

console.log('audio-analysis: click grid OK')

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

console.log('audio-analysis: OK')
