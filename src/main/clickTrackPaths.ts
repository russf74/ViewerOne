import fs from 'node:fs'
import path from 'node:path'
import { cubaseRenderDir, songTitleSlug, TAKE_ON_ME_CLICK_PREFIX } from './cubaseRenderPaths.js'

export function clickTrackPathForSong(program: number, title: string): string {
  const slug = songTitleSlug(title)
  const clickName =
    slug === 'take-on-me'
      ? `${TAKE_ON_ME_CLICK_PREFIX}pc${program}-${slug}-click.wav`
      : `pc${program}${slug ? `-${slug}` : ''}-click-48khz-pulse.wav`
  return path.join(cubaseRenderDir(), clickName)
}

/** Drop a Moises metronome next to the capture as `…-metronome.wav`. */
export function metronomeSidecarPath(renderWavPath: string): string {
  return renderWavPath.replace(/\.wav$/i, '-metronome.wav')
}

/** Sidecar first, then any other metronome/Moises WAV in the same folder (not the click). */
export function findMetronomeWavForCapture(renderWavPath: string): string | null {
  const sidecar = metronomeSidecarPath(renderWavPath)
  if (fs.existsSync(sidecar)) return sidecar
  const dir = path.dirname(renderWavPath)
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir)
  const hit = names.find(
    (n) =>
      /\.wav$/i.test(n) &&
      /metronome|moises/i.test(n) &&
      !/-click/i.test(n) &&
      path.join(dir, n) !== renderWavPath
  )
  return hit ? path.join(dir, hit) : null
}
