import path from 'node:path'
import { cubaseRenderDir, songTitleSlug, TAKE_ON_ME_FILE_PREFIX } from './cubaseRenderPaths.js'

export function clickTrackPathForSong(program: number, title: string): string {
  const slug = songTitleSlug(title)
  const clickName =
    slug === 'take-on-me'
      ? `${TAKE_ON_ME_FILE_PREFIX}pc${program}-${slug}-click.wav`
      : `pc${program}${slug ? `-${slug}` : ''}-click-48khz-pulse.wav`
  return path.join(cubaseRenderDir(), clickName)
}
