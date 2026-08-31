import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LiveBeatSync } from '../shared/liveAudioSync.js'
import { dshowAudioFilename } from '../shared/dshowAudioDevices.js'
import { resolveFfmpegPath } from './audioDecode.js'

export type LiveAudioCaptureOptions = {
  /** Windows dshow device name, e.g. "Stereo Mix (Realtek...)". */
  deviceName?: string
  onError?: (message: string) => void
}

/**
 * Capture system loopback audio via ffmpeg (Windows dshow / Linux pulse).
 * Feeds PCM chunks into {@link LiveBeatSync}.
 */
export class LiveAudioCapture {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readonly sync: LiveBeatSync
  private chunkMs = 0
  private readonly sampleRate = 22050
  private buffer = Buffer.alloc(0)
  private readonly frameBytes = 4 * 1024 // float32 samples

  constructor(sync: LiveBeatSync) {
    this.sync = sync
  }

  get capturing(): boolean {
    return this.proc != null
  }

  start(opts: LiveAudioCaptureOptions = {}): void {
    this.stop()
    const ffmpeg = resolveFfmpegPath()
    const isWin = process.platform === 'win32'
    const args = isWin
      ? [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'dshow',
          '-i',
          dshowAudioFilename(opts.deviceName ?? 'Stereo Mix'),
          '-ac',
          '1',
          '-ar',
          String(this.sampleRate),
          '-f',
          'f32le',
          'pipe:1'
        ]
      : [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'pulse',
          '-i',
          'default',
          '-ac',
          '1',
          '-ar',
          String(this.sampleRate),
          '-f',
          'f32le',
          'pipe:1'
        ]

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.chunkMs = 0
    this.buffer = Buffer.alloc(0)

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      if (msg) opts.onError?.(msg)
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= this.frameBytes) {
        const slice = this.buffer.subarray(0, this.frameBytes)
        this.buffer = this.buffer.subarray(this.frameBytes)
        const samples = new Float32Array(
          slice.buffer,
          slice.byteOffset,
          slice.byteLength / 4
        )
        this.sync.processChunk(samples, this.chunkMs)
        this.chunkMs += (samples.length / this.sampleRate) * 1000
      }
    })

    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
    })
    proc.on('error', (err) => {
      opts.onError?.(err.message)
      this.stop()
    })
  }

  stop(): void {
    if (!this.proc) return
    this.proc.kill('SIGTERM')
    this.proc = null
    this.buffer = Buffer.alloc(0)
  }
}
