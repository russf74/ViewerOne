/**
 * Smoke test for offline audio analysis (requires ffmpeg on PATH).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMonoPcm } from '../src/shared/audioAnalysis.ts'
import { buildLightingProgram } from '../src/shared/lightingProgram.ts'

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
  console.log('BPM:', analysis.bpm)
  console.log('Sections:', analysis.sections.map((s) => `${s.label}@${s.startMs}ms`).join(', '))
  console.log('Cues:', program.cues.length)
  if (program.cues.length < 1) throw new Error('Expected at least 1 cue')
  console.log('audio-analysis: OK')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
