import { clampLedPatternId } from './ledPatterns.js'
import type { DmxCueOverride, LightingCue, LightingProgram } from './lightingProgram.js'

function normalizeDmxOverride(raw: unknown): DmxCueOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<DmxCueOverride>
  const out: DmxCueOverride = {}
  if (r.powerDomeAuto !== undefined && Number.isFinite(Number(r.powerDomeAuto))) {
    out.powerDomeAuto = Math.max(0, Math.min(5, Math.round(Number(r.powerDomeAuto))))
  }
  if (r.powerDomeDimmer !== undefined && Number.isFinite(Number(r.powerDomeDimmer))) {
    out.powerDomeDimmer = Math.max(0, Math.min(255, Math.round(Number(r.powerDomeDimmer))))
  }
  if (r.stickBrightnessScale !== undefined && Number.isFinite(Number(r.stickBrightnessScale))) {
    out.stickBrightnessScale = Math.max(0, Math.min(1, Number(r.stickBrightnessScale)))
  }
  if (r.fixture1Mode === 'off' || r.fixture1Mode === 'on' || r.fixture1Mode === 'sound') {
    out.fixture1Mode = r.fixture1Mode
  }
  if (r.fixture2Mode === 'off' || r.fixture2Mode === 'on' || r.fixture2Mode === 'sound') {
    out.fixture2Mode = r.fixture2Mode
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeCue(raw: unknown): LightingCue | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<LightingCue>
  const atMs = Number(r.atMs)
  if (!Number.isFinite(atMs) || atMs < 0) return null
  return {
    id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
    atMs: Math.round(atMs),
    ledPatternId: clampLedPatternId(r.ledPatternId),
    label: typeof r.label === 'string' ? r.label : undefined,
    brightness:
      r.brightness !== undefined && Number.isFinite(Number(r.brightness))
        ? Math.max(0, Math.min(255, Math.round(Number(r.brightness))))
        : undefined,
    dmxLook:
      r.dmxLook === 'off' || r.dmxLook === 'idle' || r.dmxLook === 'live' ? r.dmxLook : undefined,
    dmx: normalizeDmxOverride(r.dmx),
    accentDurationMs:
      r.accentDurationMs !== undefined && Number.isFinite(Number(r.accentDurationMs))
        ? Math.max(0, Math.round(Number(r.accentDurationMs)))
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
    bpm: Number.isFinite(bpm) ? Math.round(bpm) : 120,
    beatsPerBar:
      r.beatsPerBar !== undefined && Number.isFinite(Number(r.beatsPerBar))
        ? Math.max(1, Math.round(Number(r.beatsPerBar)))
        : 4
  }
}
