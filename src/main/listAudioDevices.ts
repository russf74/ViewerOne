import { spawn } from 'node:child_process'
import { resolveFfmpegPath } from './audioDecode.js'
import { parseDshowAudioDevices, sortAudioDevices } from '../shared/dshowAudioDevices.js'

const LIST_TIMEOUT_MS = 8000

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpegPath()
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, LIST_TIMEOUT_MS)
    const add = (chunk: Buffer) => {
      out += chunk.toString()
    }
    proc.stdout.on('data', add)
    proc.stderr.on('data', add)
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

/** Enabled Windows recording devices ffmpeg can open (DirectShow). */
export async function listWindowsAudioDevices(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const output = await runFfmpeg(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
  return sortAudioDevices(parseDshowAudioDevices(output))
}
