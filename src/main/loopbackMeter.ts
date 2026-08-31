import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  amplitudeToDbfs,
  measureAudioLevels,
  type LoopbackMeterSample
} from '../shared/audioLevel.js'
import { resolveFfmpegPath } from './audioDecode.js'
import {
  dshowAudioFilename,
  formatDshowOpenError
} from '../shared/dshowAudioDevices.js'

export type { LoopbackMeterSample }

const SAMPLE_RATE = 22050
const FRAME_BYTES = 4 * 512
const EMIT_MS = 25

/**
 * Sidecar VU for Lighting Studio. Opens the same dshow device Analyze will record.
 * Pause before LoopbackRecorder so Windows does not exclusive-lock the device.
 */
export class LoopbackMeter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private wanted = false
  private exclusive = 0
  private device = ''
  private lastEmitAt = 0
  private lastError: string | null = null
  private readonly emit: (sample: LoopbackMeterSample) => void

  constructor(emit: (sample: LoopbackMeterSample) => void) {
    this.emit = emit
  }

  start(deviceName: string): void {
    const next = deviceName.trim()
    const deviceChanged = next !== this.device
    this.wanted = Boolean(next)
    this.device = next
    this.lastError = null
    if (deviceChanged) this.killProc()
    this.syncProc()
  }

  stop(): void {
    this.wanted = false
    this.killProc()
    this.emitIdle()
  }

  pauseExclusive(): void {
    this.exclusive += 1
    this.syncProc()
  }

  resumeExclusive(): void {
    this.exclusive = Math.max(0, this.exclusive - 1)
    this.syncProc()
  }

  private syncProc(): void {
    const shouldRun = this.wanted && this.exclusive === 0 && Boolean(this.device)
    if (shouldRun) {
      if (!this.proc) this.spawnProc()
      return
    }
    this.killProc()
    this.emitIdle()
  }

  private snapshot(peak: number, rms: number): LoopbackMeterSample {
    return {
      peak,
      rms,
      peakDbfs: amplitudeToDbfs(peak),
      listening: Boolean(this.proc),
      paused: this.exclusive > 0,
      error: this.lastError,
      device: this.device
    }
  }

  private emitIdle(): void {
    this.emit(this.snapshot(0, 0))
  }

  private spawnProc(): void {
    this.killProc()
    const ffmpeg = resolveFfmpegPath()
    const isWin = process.platform === 'win32'
    const args = isWin
      ? [
          '-hide_banner',
          '-loglevel',
          'error',
          '-fflags',
          'nobuffer',
          '-flags',
          'low_delay',
          '-f',
          'dshow',
          '-audio_buffer_size',
          '40',
          '-i',
          dshowAudioFilename(this.device),
          '-ac',
          '1',
          '-ar',
          String(SAMPLE_RATE),
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
          String(SAMPLE_RATE),
          '-f',
          'f32le',
          'pipe:1'
        ]

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.buffer = Buffer.alloc(0)
    this.lastError = null
    this.emitIdle()

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      if (!msg) return
      this.lastError = formatDshowOpenError(msg, this.device)
      this.emitIdle()
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      let latest: Float32Array | null = null
      while (this.buffer.length >= FRAME_BYTES) {
        const slice = this.buffer.subarray(0, FRAME_BYTES)
        this.buffer = this.buffer.subarray(FRAME_BYTES)
        latest = new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4)
      }
      if (!latest) return
      const now = Date.now()
      if (now - this.lastEmitAt < EMIT_MS) return
      const { peak, rms } = measureAudioLevels(latest)
      this.lastError = null
      this.lastEmitAt = now
      this.emit(this.snapshot(peak, rms))
    })

    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
      if (this.wanted && this.exclusive === 0) {
        if (!this.lastError) this.lastError = 'Loopback meter stopped'
        this.emitIdle()
      }
    })
    proc.on('error', (err) => {
      this.lastError = err.message
      this.killProc()
      this.emitIdle()
    })
  }

  private killProc(): void {
    const proc = this.proc
    this.proc = null
    this.buffer = Buffer.alloc(0)
    if (!proc) return
    try {
      proc.kill('SIGINT')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}
