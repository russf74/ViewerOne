import path from 'node:path'
import { cubaseRenderDir } from './cubaseRenderPaths.js'

export function clickTrackPathForSong(program: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const clickName =
    slug === 'take-on-me'
      ? `pc${program}-${slug}-click-up.wav`
      : `pc${program}${slug ? `-${slug}` : ''}-click-48khz-pulse.wav`
  return path.join(cubaseRenderDir(), clickName)
}
