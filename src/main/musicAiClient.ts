/** Music AI (Moises developer) Jobs API — no Electron. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API = 'https://api.music.ai/v1'

const BEATS_SLUG_CANDIDATES = [
  'music-ai/extract-beat-map-and-bpm',
  'music-ai/transcribe-bpm-beats',
  'music-ai/beats',
  'moises/extract-beat-map-and-bpm',
  'moises/beats'
]

export type MusicAiJob = {
  id: string
  status: 'QUEUED' | 'STARTED' | 'SUCCEEDED' | 'FAILED' | string
  workflow?: string
  result?: Record<string, unknown> | null
  error?: { code?: string; title?: string; message?: string } | null
}

export function musicAiKeyPath(): string {
  return path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'music-ai-api-key.txt')
}

export function readMusicAiApiKey(): string | null {
  const env = process.env.MUSIC_AI_API_KEY || process.env.MOISES_API_KEY
  if (env && env.trim()) return env.trim()
  const file = musicAiKeyPath()
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
  return text || null
}

async function apiJson(apiKey: string, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: apiKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'message' in json
        ? String((json as { message: unknown }).message)
        : text.slice(0, 400)
    throw new Error(`Music AI ${method} ${pathname} ${res.status}: ${msg}`)
  }
  return json
}

export async function musicAiPing(apiKey: string): Promise<{ id: string; name: string }> {
  const json = (await apiJson(apiKey, 'GET', '/application')) as { id: string; name: string }
  return json
}

type WorkflowRow = { slug?: string; name?: string; description?: string }

export async function listWorkflows(apiKey: string): Promise<WorkflowRow[]> {
  const out: WorkflowRow[] = []
  for (let page = 0; page < 20; page++) {
    const json = (await apiJson(apiKey, 'GET', `/workflow?page=${page}&size=50`)) as {
      workflows?: WorkflowRow[]
    }
    const batch = json.workflows ?? []
    out.push(...batch)
    if (batch.length < 50) break
  }
  return out
}

export async function resolveBeatsWorkflow(apiKey: string): Promise<string> {
  const listed = await listWorkflows(apiKey)
  const fromList = listed.find((w) => {
    const blob = `${w.slug ?? ''} ${w.name ?? ''} ${w.description ?? ''}`.toLowerCase()
    return /beat/.test(blob) && /bpm|map|metronome|tempo/.test(blob)
  })
  if (fromList?.slug) return fromList.slug
  const anyBeat = listed.find((w) => /beat|bpm/i.test(`${w.slug ?? ''} ${w.name ?? ''}`))
  if (anyBeat?.slug) return anyBeat.slug
  return BEATS_SLUG_CANDIDATES[0]!
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.ogg') return 'audio/ogg'
  return 'audio/wav'
}

export async function uploadLocalAudio(apiKey: string, filePath: string): Promise<string> {
  const signed = (await apiJson(apiKey, 'GET', '/upload')) as {
    uploadUrl: string
    downloadUrl: string
  }
  if (!signed.uploadUrl || !signed.downloadUrl) throw new Error('Music AI upload URLs missing')
  const buf = fs.readFileSync(filePath)
  const put = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentTypeFor(filePath) },
    body: buf
  })
  if (!put.ok) {
    const err = await put.text()
    throw new Error(`Music AI file PUT ${put.status}: ${err.slice(0, 300)}`)
  }
  return signed.downloadUrl
}

export async function createJob(
  apiKey: string,
  name: string,
  workflow: string,
  params: Record<string, string>
): Promise<string> {
  const json = (await apiJson(apiKey, 'POST', '/job', { name, workflow, params })) as { id: string }
  if (!json.id) throw new Error('Music AI create job returned no id')
  return json.id
}

export async function getJob(apiKey: string, id: string): Promise<MusicAiJob> {
  return (await apiJson(apiKey, 'GET', `/job/${id}`)) as MusicAiJob
}

export async function waitForJob(
  apiKey: string,
  id: string,
  timeoutMs = 20 * 60 * 1000
): Promise<MusicAiJob> {
  const t0 = Date.now()
  let delay = 4000
  for (;;) {
    const job = await getJob(apiKey, id)
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job
    if (Date.now() - t0 > timeoutMs) throw new Error(`Music AI job ${id} timed out (${job.status})`)
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(15000, delay + 1000)
  }
}

export async function downloadUrlToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
}

export async function downloadUrlText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status} ${url}`)
  return await res.text()
}

/** Pull bpm + beat-map JSON from a succeeded job result (inline or URL). */
export async function readJobBeatMap(job: MusicAiJob, cacheDir: string): Promise<unknown> {
  const result = job.result ?? {}
  const bpmRaw = result.bpm
  let wrapper: Record<string, unknown> = {}
  if (typeof bpmRaw === 'number') wrapper.bpm = bpmRaw
  if (typeof bpmRaw === 'string' && /^https?:\/\//i.test(bpmRaw)) {
    const t = await downloadUrlText(bpmRaw)
    const n = Number(t.trim())
    if (Number.isFinite(n)) wrapper.bpm = n
  } else if (typeof bpmRaw === 'string' && Number.isFinite(Number(bpmRaw))) {
    wrapper.bpm = Number(bpmRaw)
  }

  const mapVal = result.beatMap ?? result.beat_map ?? result.beats
  if (mapVal && typeof mapVal === 'object') {
    return { ...wrapper, ...(mapVal as object), bpm: wrapper.bpm ?? (mapVal as { bpm?: number }).bpm }
  }
  if (typeof mapVal === 'string' && /^https?:\/\//i.test(mapVal)) {
    const dest = path.join(cacheDir, `beatmap-${job.id}.json`)
    await downloadUrlToFile(mapVal, dest)
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as object), ...wrapper }
    }
    return { ...wrapper, beats: parsed }
  }
  if (typeof mapVal === 'string') {
    try {
      return { ...wrapper, ...(JSON.parse(mapVal) as object) }
    } catch {
      /* ignore */
    }
  }
  return Object.keys(wrapper).length ? wrapper : result
}
