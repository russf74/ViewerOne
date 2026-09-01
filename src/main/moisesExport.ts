import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Folder on the Desktop for Moises app uploads. */
export function moisesUploadDir(): string {
  const dir = path.join(os.homedir(), 'Desktop', 'Moises-upload')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function moisesWavFileName(program: number, title: string): string {
  const safe = title.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim() || `PC ${program}`
  return `${String(program).padStart(2, '0')} ${safe}.wav`
}

export function moisesWavPath(program: number, title: string): string {
  return path.join(moisesUploadDir(), moisesWavFileName(program, title))
}

export function moisesWavExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 20_000
  } catch {
    return false
  }
}

/** Byte-copy the Cubase capture — no resample, no MP3 encode. */
export function copyCaptureWavForMoises(wavPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  if (path.resolve(wavPath) === path.resolve(destPath)) return
  fs.copyFileSync(wavPath, destPath)
}
