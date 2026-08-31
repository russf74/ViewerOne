import type { DmxFixtureMode } from './dmx.js'
import { complementaryDomePatternId, complementaryStickPatternId } from './dmx.js'
import type { SongAudioAnalysis } from './audioAnalysis.js'
import { clampLedPatternId } from './ledPatterns.js'

export type DmxCueOverride = {
  /** PowerDome auto program 1–5; 0 = manual RGB from pattern. */
  powerDomeAuto?: number
  powerDomeDimmer?: number
  /** Scale stick pixel brightness 0–1. */
  stickBrightnessScale?: number
  /** Freedom Stick animation pattern (defaults to a complement of the ESP pattern). */
  stickPatternId?: number
  /** PowerDome colour/spin look (defaults to a complement of the ESP pattern). */
  domePatternId?: number
  fixture1Mode?: DmxFixtureMode
  fixture2Mode?: DmxFixtureMode
}

export type LightingCue = {
  id?: string
  /** Milliseconds from song start (performance clock). */
  atMs: number
  ledPatternId: number
  label?: string
  brightness?: number
  dmxLook?: 'off' | 'idle' | 'live'
  dmx?: DmxCueOverride
  /** If set, revert to previous pattern after this many ms (accent flash). */
  accentDurationMs?: number
}

export type LightingProgram = {
  version: 1
  generatedAt: string
  cues: LightingCue[]
  bpm: number
  /** Beats per bar assumed when building bar-aligned cues. */
  beatsPerBar?: number
}

export type BuildProgramOptions = {
  beatsPerBar?: number
  /** Add subtle pattern shift every N bars within sections. */
  barAccentEvery?: number
}

/** Pattern palette mapped by section energy / role. */
const SECTION_PATTERN: Record<string, number> = {
  intro: 2,
  verse: 3,
  prechorus: 8,
  chorus: 16,
  bridge: 12,
  breakdown: 21,
  drop: 18,
  outro: 0,
  unknown: 20,
  fill: 14,
  build: 13
}

const HIGH_ENERGY_BOOST: Record<string, number | null> = {
  intro: null,
  verse: null,
  prechorus: 13,
  chorus: 11,
  bridge: 15,
  breakdown: null,
  drop: 10,
  outro: null,
  unknown: null,
  fill: 14,
  build: 13
}

function snapToBeat(ms: number, analysis: SongAudioAnalysis): number {
  if (!analysis.beatTimesMs.length) return ms
  let best = analysis.beatTimesMs[0]
  let bestDist = Math.abs(ms - best)
  for (const b of analysis.beatTimesMs) {
    const d = Math.abs(ms - b)
    if (d < bestDist) {
      best = b
      bestDist = d
    }
    if (b > ms + 500) break
  }
  return bestDist < 180 ? best : ms
}

function patternForSection(label: string, energy: number): number {
  if (energy > 0.85 && (label === 'chorus' || label === 'drop')) {
    return HIGH_ENERGY_BOOST[label] ?? SECTION_PATTERN[label] ?? 20
  }
  if (energy < 0.3 && label !== 'outro' && label !== 'intro') {
    return SECTION_PATTERN.breakdown ?? 21
  }
  return SECTION_PATTERN[label] ?? 20
}

function dmxLookForSection(label: string): 'off' | 'idle' | 'live' {
  if (label === 'breakdown' || label === 'outro') return 'idle'
  return 'live'
}

function dmxForSection(espPatternId: number, energy: number): DmxCueOverride {
  return {
    stickPatternId: complementaryStickPatternId(espPatternId),
    domePatternId: complementaryDomePatternId(espPatternId),
    stickBrightnessScale: energy > 0.72 ? 1 : energy > 0.4 ? 0.78 : 0.5
  }
}

const SECTION_PATTERN_CYCLE = [2, 3, 8, 16, 12, 13, 18, 6, 9, 14, 4, 17, 1, 19] as const

function uniqueEspPattern(label: string, energy: number, used: Set<number>, index: number): number {
  let p = patternForSection(label, energy)
  if (used.has(p)) {
    p = SECTION_PATTERN_CYCLE[index % SECTION_PATTERN_CYCLE.length]
    let guard = 0
    while (used.has(p) && guard < SECTION_PATTERN_CYCLE.length) {
      p = SECTION_PATTERN_CYCLE[(index + guard + 1) % SECTION_PATTERN_CYCLE.length]
      guard++
    }
  }
  used.add(p)
  return clampLedPatternId(p)
}

/** Detect short energy spikes between sections → fill cues. */
function findEnergySpikes(analysis: SongAudioAnalysis): { atMs: number; strength: number }[] {
  const spikes: { atMs: number; strength: number }[] = []
  const sections = analysis.sections
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1]
    const cur = sections[i]
    const jump = cur.energy - prev.energy
    if (jump > 0.35 && cur.label !== 'intro') {
      spikes.push({ atMs: cur.startMs, strength: jump })
    }
  }
  return spikes
}

/**
 * Build a professional timed lighting program from analysis.
 * Snaps to beats, adds bar accents, section DMX, and fill hits.
 */
export function buildLightingProgram(
  analysis: SongAudioAnalysis,
  options: BuildProgramOptions = {}
): LightingProgram {
  const beatsPerBar = options.beatsPerBar ?? 4
  const beatMs = 60000 / Math.max(60, analysis.bpm)
  const cues: LightingCue[] = []
  const usedEsp = new Set<number>()

  for (let i = 0; i < analysis.sections.length; i++) {
    const section = analysis.sections[i]
    const label = section.label
    const atMs = snapToBeat(section.startMs, analysis)
    const patternId = uniqueEspPattern(label, section.energy, usedEsp, i)
    cues.push({
      id: crypto.randomUUID(),
      atMs,
      ledPatternId: patternId,
      label,
      dmxLook: dmxLookForSection(label),
      dmx: dmxForSection(patternId, section.energy)
    })

    if (section.energy > 0.75 && (label === 'chorus' || label === 'drop')) {
      const hitPattern = clampLedPatternId(18)
      cues.push({
        id: crypto.randomUUID(),
        atMs: snapToBeat(Math.round(atMs + beatMs), analysis),
        ledPatternId: hitPattern,
        label: `${label} hit`,
        accentDurationMs: Math.round(beatMs * 0.75),
        dmx: dmxForSection(hitPattern, 1)
      })
    }
  }

  for (const spike of findEnergySpikes(analysis)) {
    cues.push({
      id: crypto.randomUUID(),
      atMs: snapToBeat(spike.atMs, analysis),
      ledPatternId: clampLedPatternId(14),
      label: 'fill',
      accentDurationMs: Math.round(beatMs),
      dmxLook: 'live'
    })
  }

  if (cues.length === 0 || cues[0].atMs > 0) {
    cues.unshift({
      id: crypto.randomUUID(),
      atMs: 0,
      ledPatternId: 2,
      label: 'start',
      dmxLook: 'live'
    })
  }

  cues.sort((a, b) => a.atMs - b.atMs)
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    cues: compactCues(cues),
    bpm: analysis.bpm,
    beatsPerBar
  }
}

function compactCues(cues: LightingCue[]): LightingCue[] {
  const compact: LightingCue[] = []
  for (const cue of cues) {
    const prev = compact[compact.length - 1]
    if (
      prev &&
      prev.ledPatternId === cue.ledPatternId &&
      !cue.accentDurationMs &&
      !prev.accentDurationMs &&
      Math.abs(prev.atMs - cue.atMs) < 500
    ) {
      continue
    }
    compact.push(cue)
  }
  return compact
}

export type ActiveCueState = {
  base: LightingCue
  /** Non-null when inside an accent flash window. */
  accent: LightingCue | null
}

/** Resolve base + optional accent overlay at `atMs`. */
export function resolveActiveCues(
  program: LightingProgram | undefined,
  atMs: number
): ActiveCueState | null {
  if (!program?.cues?.length) return null

  let base: LightingCue | null = null
  let accent: LightingCue | null = null

  for (const cue of program.cues) {
    if (cue.atMs <= atMs) {
      if (cue.accentDurationMs) {
        const end = cue.atMs + cue.accentDurationMs
        if (atMs >= cue.atMs && atMs < end) accent = cue
      } else {
        base = cue
      }
    } else break
  }

  if (!base && accent) base = accent
  if (!base) return null
  return { base, accent: accent && accent !== base ? accent : null }
}

/** @deprecated use resolveActiveCues */
export function activeLightingCue(program: LightingProgram | undefined, atMs: number): LightingCue | null {
  const state = resolveActiveCues(program, atMs)
  if (!state) return null
  return state.accent ?? state.base
}

export function nextLightingCue(program: LightingProgram | undefined, atMs: number): LightingCue | null {
  if (!program?.cues?.length) return null
  for (const cue of program.cues) {
    if (cue.atMs > atMs) return cue
  }
  return null
}

export function parseTimecodeToMs(raw: string): number | null {
  const t = raw.trim()
  const m = /^(\d+):(\d{2})(?:\.(\d{1,3}))?$/.exec(t)
  if (m) {
    const sec = Number(m[1]) * 60 + Number(m[2])
    const frac = m[3] ? Number(m[3]) / 1000 : 0
    return Math.round(sec * 1000 + frac * 1000)
  }
  const m2 = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(t)
  if (m2) {
    const sec = Number(m2[1]) * 3600 + Number(m2[2]) * 60 + Number(m2[3])
    const frac = m2[4] ? Number(m2[4]) / 1000 : 0
    return Math.round(sec * 1000 + frac * 1000)
  }
  return null
}

export function formatMsToTimecode(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
