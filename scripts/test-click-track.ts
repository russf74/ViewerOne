import { analyzeMonoPcm } from '../src/shared/audioAnalysis.js'
import { synthesizeClickTrack } from '../src/shared/clickTrack.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))))
  })
}

const dir = mkdtempSync(join(tmpdir(), 'vo-click-'))
const wav = join(dir, 'tone.wav')
try {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '22050', '-ac', '1', wav],
      { stdio: 'inherit' }
    )
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`gen ${c}`))))
  })
  const raw = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'])
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const analysis = analyzeMonoPcm(samples, 22050)
  const { samples: click, countInMs } = synthesizeClickTrack(analysis, { countInBars: 2, accentEvery: 4 })
  if (click.length < 1000) throw new Error('click too short')
  if (countInMs <= 0) throw new Error('count-in missing')
  console.log('click-track: OK', { bpm: analysis.bpm, samples: click.length, countInMs })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
