import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** Fresh Take On Me capture/click names so Cubase does not reuse an old pool clip. */
export const TAKE_ON_ME_FILE_PREFIX = '001-'

/** Persisted Cubase render captures — keyed by song program number. */
export function cubaseRenderDir(): string {
  const dir = path.join(app.getPath('userData'), 'renders')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function songTitleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function cubaseRenderPathForSong(program: number, title: string): string {
  const slug = songTitleSlug(title)
  const name =
    slug === 'take-on-me'
      ? `${TAKE_ON_ME_FILE_PREFIX}pc${program}-${slug}.wav`
      : `pc${program}${slug ? `-${slug}` : ''}.wav`
  return path.join(cubaseRenderDir(), name)
}
