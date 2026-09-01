import type { SetlistItem } from './types.js'

export type LightingReadinessRow = {
  id: string
  title: string
  program: number
  hasCubaseRender: boolean
  hasAnalysis: boolean
  hasProgram: boolean
  cueCount: number
  bpm: number | null
  ready: boolean
  issues: string[]
}

export type LightingReadinessReport = {
  totalSongs: number
  readyCount: number
  rows: LightingReadinessRow[]
  gigReady: boolean
}

function isPerformanceSong(row: SetlistItem): boolean {
  const t = row.title.toUpperCase()
  if (t.includes('SOUNDCHECK')) return false
  if (t.startsWith('INTRO') || t.startsWith('OUTRO')) return false
  return row.program >= 1 && row.program <= 119
}

export function auditLightingReadiness(setlist: SetlistItem[]): LightingReadinessReport {
  const rows: LightingReadinessRow[] = []
  let readyCount = 0

  for (const row of setlist) {
    if (!isPerformanceSong(row)) continue
    const issues: string[] = []
    const hasCubaseRender = row.audioSource === 'cubase-render' && Boolean(row.cubaseRenderPath)
    const hasAnalysis = Boolean(row.audioAnalysis?.bpm)
    const hasProgram = Boolean(row.lightingProgram?.cues?.length)
    const cueCount = row.lightingProgram?.cues.length ?? 0
    const bpm = row.audioAnalysis?.bpm ?? null

    if (!hasCubaseRender && row.audioSource !== 'external-file') {
      issues.push('No Cubase render — run Analyze from Cubase')
    }
    if (!hasAnalysis) issues.push('Missing BPM/beat analysis')
    if (!hasProgram) issues.push('No lighting program')

    const ready = issues.length === 0
    if (ready) readyCount++
    rows.push({
      id: row.id,
      title: row.title,
      program: row.program,
      hasCubaseRender,
      hasAnalysis,
      hasProgram,
      cueCount,
      bpm,
      ready,
      issues
    })
  }

  return {
    totalSongs: rows.length,
    readyCount,
    rows,
    gigReady: rows.length > 0 && readyCount === rows.length
  }
}
