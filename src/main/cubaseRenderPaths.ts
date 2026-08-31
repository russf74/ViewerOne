import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** Persisted Cubase render captures — keyed by song program number. */
export function cubaseRenderDir(): string {
  const dir = path.join(app.getPath('userData'), 'renders')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cubaseRenderPathForSong(program: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const name = `pc${program}${slug ? `-${slug}` : ''}.wav`
  return path.join(cubaseRenderDir(), name)
}
