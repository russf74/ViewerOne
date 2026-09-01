import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { decodeAudioFileToMonoPcm, resolveFfmpegPath } from './audioDecode.js'

const TARGET_PEAK = 0.89

function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = resolveFfmpegPath()
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim() || `ffmpeg exited ${code}`))
      else resolve()
    })
  })
}

/**
 * Peak-normalize a capture to ~-1 dBFS so Cubase shows a full waveform and
 * beat-finding does not depend on Cubase/Windows faders being up.
 */
export async function peakNormalizeWavFile(
  filePath: string,
  targetPeak = TARGET_PEAK
): Promise<{ peakBefore: number; peakAfter: number }> {
  const { samples, sampleRate } = await decodeAudioFileToMonoPcm(filePath, 48000)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] ?? 0)
    if (a > peak) peak = a
  }
  if (peak < 0.004) {
    throw new Error(`capture too quiet to raise (peak ${peak.toFixed(4)})`)
  }
  const gain = targetPeak / peak
  if (gain <= 1.02) {
    return { peakBefore: peak, peakAfter: peak }
  }
  const tmp = path.join(
    os.tmpdir(),
    `vo-norm-${process.pid}-${Date.now()}.wav`
  )
  try {
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      String(sampleRate > 0 ? sampleRate : 48000),
      '-af',
      `volume=${gain}`,
      '-c:a',
      'pcm_s16le',
      tmp
    ])
    fs.copyFileSync(tmp, filePath)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  return { peakBefore: peak, peakAfter: targetPeak }
}
