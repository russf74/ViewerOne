import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveFfmpegPath } from './audioDecode.js'

export type LoopbackRecordOptions = {
  outputPath: string
  /** Windows dshow device name, e.g. "Stereo Mix (Realtek...)". */
  deviceName?: string
  sampleRate?: number
  onError?: (message: string) => void
}

/**
 * Record system loopback audio to a WAV file via ffmpeg.
 * Sidecar-only — used during explicit Cubase render capture, never during normal gig flow.
 */
export class LoopbackRecorder {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readonly sampleRate: number

  constructor(sampleRate = 22050) {
    this.sampleRate = sampleRate
  }

  get recording(): boolean {
    return this.proc != null
  }

  start(opts: LoopbackRecordOptions): void {
    this.stop()
    const ffmpeg = resolveFfmpegPath()
    const isWin = process.platform === 'win32'
    const args = isWin
      ? [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'dshow',
          '-i',
          `audio=${opts.deviceName ?? 'Stereo Mix'}`,
          '-ac',
          '1',
          '-ar',
          String(opts.sampleRate ?? this.sampleRate),
          '-c:a',
          'pcm_s16le',
          opts.outputPath
        ]
      : [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'pulse',
          '-i',
          'default',
          '-ac',
          '1',
          '-ar',
          String(opts.sampleRate ?? this.sampleRate),
          '-c:a',
          'pcm_s16le',
          opts.outputPath
        ]

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      if (msg) opts.onError?.(msg)
    })
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
    })
    proc.on('error', (err) => {
      opts.onError?.(err.message)
      this.stop()
    })
  }

  stop(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (!proc) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 3000)
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        proc.kill('SIGINT')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
