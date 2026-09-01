/**
 * Music AI (Moises developer API) → bar-accent click WAV.
 *
 *   npx tsx scripts/moises-click.ts
 *   npx tsx scripts/moises-click.ts --all
 *
 * API key: %APPDATA%\viewer-one\music-ai-api-key.txt
 * (or MUSIC_AI_API_KEY / MOISES_API_KEY)
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  clickWavPathForSong,
  rendersDir,
  setlistRowsWithCaptures,
  writeBarAccentClickFromCapture
} from '../src/main/musicAiClick.ts'
import { musicAiKeyPath, musicAiPing, readMusicAiApiKey } from '../src/main/musicAiClient.ts'

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  const logPath = path.join(process.env.APPDATA ?? '', 'viewer-one', 'moises-click.log')
  try {
    fs.appendFileSync(logPath, line + '\n')
  } catch {
    /* ignore */
  }
}

const all = process.argv.includes('--all')
const apiKey = readMusicAiApiKey()
if (!apiKey) {
  logLine(`No Music AI API key. Put it in ${musicAiKeyPath()}`)
  logLine('That key comes from https://music.ai (Applications) — Moises app Premium is a different product.')
  process.exit(1)
}

const app = await musicAiPing(apiKey)
logLine(`Music AI app: ${app.name} (${app.id})`)

const takeOnMe = setlistRowsWithCaptures().find((r) => r.title === 'Take on me') ?? {
  program: 4,
  title: 'Take on me',
  capturePath: path.join(rendersDir(), '006-pc4-take-on-me.wav')
}

const rows = all
  ? setlistRowsWithCaptures()
  : [takeOnMe].filter((r) => fs.existsSync(r.capturePath))

if (!rows.length) {
  logLine('No capture WAV to process')
  process.exit(1)
}

let failed = 0
for (const row of rows) {
  const clickPath = clickWavPathForSong(row.program, row.title)
  logLine(`START PC${row.program} ${row.title} ← ${row.capturePath}`)
  try {
    const done = await writeBarAccentClickFromCapture({
      apiKey,
      capturePath: row.capturePath,
      program: row.program,
      title: row.title
    })
    logLine(
      `OK PC${row.program} ${row.title} bpm=${done.bpm.toFixed(2)} hits=${done.onsets} phase=${done.accentPhase} job=${done.jobId} → ${clickPath}`
    )
  } catch (err) {
    failed++
    logLine(`FAIL PC${row.program} ${row.title}: ${err instanceof Error ? err.message : err}`)
    if (!all) process.exit(1)
  }
}

if (failed) {
  logLine(`done with ${failed} failure(s)`)
  process.exit(1)
}
logLine('done')
