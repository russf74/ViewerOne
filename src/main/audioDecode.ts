import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Resolve ffmpeg binary — bundled static on Windows builds, system PATH elsewhere. */
export function resolveFfmpegPath(): string {
  try {
    const staticPath = require('ffmpeg-static') as string | null
    if (staticPath && existsSync(staticPath)) return staticPath
  } catch {
    /* optional dependency */
  }
  return 'ffmpeg'
}

const DECODE_SAMPLE_RATE = 22050

/**
 * Decode an audio file to mono float32 PCM via ffmpeg.
 */
export async function decodeAudioFileToMonoPcm(filePath: string): Promise<{
  samples: Float32Array
  sampleRate: number
  durationMs: number
}> {
  if (!existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`)
  }

  const ffmpeg = resolveFfmpegPath()
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-ac',
    '1',
    '-ar',
    String(DECODE_SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1'
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)))
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
        return
      }
      const buf = Buffer.concat(chunks)
      const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      const durationMs = Math.round((samples.length / DECODE_SAMPLE_RATE) * 1000)
      resolve({ samples, sampleRate: DECODE_SAMPLE_RATE, durationMs })
    })
  })
}
