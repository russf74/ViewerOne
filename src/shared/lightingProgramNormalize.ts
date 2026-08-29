import { clampLedPatternId } from './ledPatterns.js'
import type { LightingCue, LightingProgram } from './lightingProgram.js'

function normalizeCue(raw: unknown): LightingCue | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<LightingCue>
  const atMs = Number(r.atMs)
  if (!Number.isFinite(atMs) || atMs < 0) return null
  return {
    atMs: Math.round(atMs),
    ledPatternId: clampLedPatternId(r.ledPatternId),
    label: typeof r.label === 'string' ? r.label : undefined,
    brightness:
      r.brightness !== undefined && Number.isFinite(Number(r.brightness))
        ? Math.max(0, Math.min(255, Math.round(Number(r.brightness))))
        : undefined
  }
}

export function normalizeLightingProgram(raw: unknown): LightingProgram | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<LightingProgram>
  const cues = Array.isArray(r.cues)
    ? r.cues.map(normalizeCue).filter((c): c is LightingCue => c != null)
    : []
  if (cues.length === 0) return undefined
  cues.sort((a, b) => a.atMs - b.atMs)
  const bpm = Number(r.bpm)
  return {
    version: 1,
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : new Date().toISOString(),
    cues,
    bpm: Number.isFinite(bpm) ? Math.round(bpm) : 120
  }
}
