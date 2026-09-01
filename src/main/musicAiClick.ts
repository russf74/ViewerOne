/** Turn a Cubase capture into a bar-accent click using Music AI beat times. */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeClickTrackWav } from './clickTrackWav.js'
import { parseBeatMapJson } from '../shared/beatMapParse.js'
import { metronomeOnsetsMs, pickDownbeatPhase } from '../shared/metronomeOnsets.js'
import type { SongAudioAnalysis } from '../shared/audioAnalysis.js'
import { buildLightingProgram } from '../shared/lightingProgram.js'
import {
  createJob,
  downloadUrlToFile,
  readJobBeatMap,
  resolveBeatsWorkflow,
  uploadLocalAudio,
  waitForJob
} from './musicAiClient.js'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string

export function rendersDir(): string {
  const dir = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'renders')
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

export function clickWavPathForSong(program: number, title: string): string {
  const slug = songTitleSlug(title)
  const name =
    slug === 'take-on-me'
      ? `007-pc${program}-${slug}-click.wav`
      : `pc${program}${slug ? `-${slug}` : ''}-click-48khz-pulse.wav`
  return path.join(rendersDir(), name)
}

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('close', (code) => (code !== 0 ? reject(new Error(err || `ffmpeg ${code}`)) : resolve(Buffer.concat(chunks))))
  })
}

export async function decodeMono48k(file: string): Promise<Float32Array> {
  const raw = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1'
  ])
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}

function resultUrl(result: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!result) return null
  for (const k of keys) {
    const v = result[k]
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
  }
  return null
}

export type MoisesClickResult = {
  clickPath: string
  bpm: number
  onsets: number
  accentPhase: number
  jobId: string
  workflow: string
}

export async function writeBarAccentClickFromCapture(opts: {
  apiKey: string
  capturePath: string
  program: number
  title: string
  workflow?: string
  patchConfig?: boolean
}): Promise<MoisesClickResult> {
  const { apiKey, capturePath, program, title } = opts
  if (!fs.existsSync(capturePath)) throw new Error(`missing capture ${capturePath}`)
  const cacheDir = path.join(rendersDir(), '_moises')
  fs.mkdirSync(cacheDir, { recursive: true })
  const workflow = opts.workflow ?? (await resolveBeatsWorkflow(apiKey))
  const inputUrl = await uploadLocalAudio(apiKey, capturePath)
  const jobId = await createJob(apiKey, `vo-${program}-${songTitleSlug(title)}`, workflow, {
    inputUrl,
    inputFileUrl: inputUrl
  })
  const job = await waitForJob(apiKey, jobId)
  if (job.status === 'FAILED') {
    throw new Error(job.error?.message || job.error?.title || `job ${jobId} failed`)
  }
  const rawMap = await readJobBeatMap(job, cacheDir)
  fs.writeFileSync(
    path.join(cacheDir, `${program}-${songTitleSlug(title)}-beatmap.json`),
    JSON.stringify(rawMap, null, 2)
  )
  let parsed = parseBeatMapJson(rawMap)
  if (parsed.timesMs.length < 8) {
    const metroUrl = resultUrl(job.result ?? undefined, ['metronome', 'click', 'clickTrack'])
    if (metroUrl) {
      const metroPath = path.join(cacheDir, `${program}-${songTitleSlug(title)}-metronome.wav`)
      await downloadUrlToFile(metroUrl, metroPath)
      const metroPcm = await decodeMono48k(metroPath)
      parsed = {
        timesMs: metronomeOnsetsMs(metroPcm, 48000),
        accentPhase: 0,
        bpm: parsed.bpm,
        fromBeatNumbers: false
      }
    }
  }
  if (parsed.timesMs.length < 8) {
    throw new Error(`beat map too short (${parsed.timesMs.length} hits) job ${jobId}`)
  }
  const songPcm = await decodeMono48k(capturePath)
  const accentPhase = parsed.fromBeatNumbers
    ? parsed.accentPhase
    : pickDownbeatPhase(parsed.timesMs, songPcm, 48000)
  const bpm = parsed.bpm && parsed.bpm > 40 ? parsed.bpm : medianFromTimes(parsed.timesMs)
  const durationMs = (songPcm.length / 48000) * 1000
  const analysis: SongAudioAnalysis = {
    analyzedAt: new Date().toISOString(),
    durationMs,
    sampleRate: 48000,
    bpm,
    beatOffsetMs: parsed.timesMs[0] ?? 0,
    beatTimesMs: parsed.timesMs.slice(0, 512).map((t) => Math.round(t)),
    clickBeatsMs: parsed.timesMs,
    sections: [],
    peakEnergy: 0.5
  }
  const clickPath = clickWavPathForSong(program, title)
  writeClickTrackWav(clickPath, analysis, {
    countInBars: 0,
    embedCountIn: true,
    accentEvery: 4,
    accentPhase,
    sampleRate: 48000,
    durationSamples: songPcm.length
  })
  if (opts.patchConfig !== false) patchSongClick(title, analysis, clickPath)
  return {
    clickPath,
    bpm,
    onsets: parsed.timesMs.length,
    accentPhase,
    jobId,
    workflow
  }
}

function medianFromTimes(times: number[]): number {
  const iois: number[] = []
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!
    if (d > 180 && d < 1200) iois.push(d)
  }
  if (!iois.length) return 120
  iois.sort((a, b) => a - b)
  return 60000 / iois[Math.floor(iois.length / 2)]!
}

function patchSongClick(title: string, analysis: SongAudioAnalysis, clickPath: string): void {
  const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
  if (!fs.existsSync(configPath)) return
  const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { setlist?: Array<Record<string, unknown>> }
  const song = j.setlist?.find((s) => String(s.title) === title)
  if (!song) return
  const lighting = buildLightingProgram(analysis)
  song.audioAnalysis = analysis
  song.lightingProgram = lighting
  song.clickTrackPath = clickPath
  song.clickTrackCountInMs = 0
  fs.writeFileSync(configPath, JSON.stringify(j, null, '\t') + '\n')
}

export function isClickableSetlistTitle(title: string): boolean {
  const t = title.trim().toUpperCase()
  if (!t) return false
  if (t.startsWith('INTRO') || t.startsWith('OUTRO')) return false
  if (t.startsWith('SOUNDCHECK')) return false
  return true
}

export type SetlistClickRow = { program: number; title: string; capturePath: string }

export function setlistRowsWithCaptures(): SetlistClickRow[] {
  const configPath = path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'viewer-one-config.json')
  if (!fs.existsSync(configPath)) return []
  const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { setlist?: Array<Record<string, unknown>> }
  const dir = rendersDir()
  const out: SetlistClickRow[] = []
  for (const s of j.setlist ?? []) {
    const title = String(s.title ?? '')
    const program = Number(s.program)
    if (!isClickableSetlistTitle(title) || !Number.isFinite(program) || program < 1) continue
    const named = [
      typeof s.cubaseRenderPath === 'string' ? s.cubaseRenderPath : '',
      path.join(dir, `pc${program}-${songTitleSlug(title)}.wav`),
      path.join(dir, `pc${program}.wav`)
    ]
    if (songTitleSlug(title) === 'take-on-me') {
      named.unshift(path.join(dir, `006-pc${program}-take-on-me.wav`))
    }
    const capturePath = named.find((p) => p && fs.existsSync(p))
    if (!capturePath) continue
    out.push({ program, title, capturePath })
  }
  return out
}
