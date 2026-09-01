import type { DmxFixtureMode } from './dmx.js'
import { complementaryDomePatternId, complementaryStickPatternId } from './dmx.js'
import type { SongAudioAnalysis } from './audioAnalysis.js'
import { snapToBarMs } from './audioAnalysis.js'
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

function snapToBar(ms: number, analysis: SongAudioAnalysis, beatsPerBar = 4): number {
  return snapToBarMs(ms, analysis.bpm, analysis.beatOffsetMs, beatsPerBar)
}

const HIGH_ENERGY_CYCLE = [16, 18, 11, 10, 14, 15, 13, 19, 7, 4] as const
const MID_ENERGY_CYCLE = [8, 12, 6, 9, 3, 17, 1] as const
const LOW_ENERGY_CYCLE = [5, 2, 21, 3, 9] as const

function patternForSection(label: string, energy: number): number {
  if (energy >= 0.62) {
    if (label === 'drop') return 18
    if (label === 'chorus') return 16
    return 11
  }
  if (energy < 0.28 && (label === 'outro' || label === 'breakdown')) return 0
  if (energy < 0.35) return SECTION_PATTERN.breakdown ?? 21
  return SECTION_PATTERN[label] === 0 ? 8 : (SECTION_PATTERN[label] ?? 8)
}

function dmxLookForSection(label: string, energy: number): 'off' | 'idle' | 'live' {
  if ((label === 'breakdown' || label === 'outro') && energy < 0.4) return 'idle'
  return 'live'
}

function dmxForSection(espPatternId: number, energy: number): DmxCueOverride {
  return {
    stickPatternId: complementaryStickPatternId(espPatternId),
    domePatternId: complementaryDomePatternId(espPatternId),
    stickBrightnessScale: energy > 0.72 ? 1 : energy > 0.4 ? 0.78 : 0.5
  }
}

function uniqueEspPattern(label: string, energy: number, used: Set<number>, index: number): number {
  const cycle =
    energy >= 0.62 ? HIGH_ENERGY_CYCLE : energy >= 0.38 ? MID_ENERGY_CYCLE : LOW_ENERGY_CYCLE
  let p = patternForSection(label, energy)
  if (energy >= 0.5 && (p === 0 || p === 21)) p = HIGH_ENERGY_CYCLE[index % HIGH_ENERGY_CYCLE.length]
  if (used.has(p)) {
    let guard = 0
    p = cycle[index % cycle.length]
    while (used.has(p) && guard < cycle.length) {
      p = cycle[(index + guard + 1) % cycle.length]
      guard++
    }
  }
  used.add(p)
  return clampLedPatternId(p)
}

/**
 * Build a professional timed lighting program from analysis.
 * Section changes snap to bar downbeats (same grid as the click).
 */
export function buildLightingProgram(
  analysis: SongAudioAnalysis,
  options: BuildProgramOptions = {}
): LightingProgram {
  const beatsPerBar = options.beatsPerBar ?? 4
  const cues: LightingCue[] = []
  const usedEsp = new Set<number>()

  for (let i = 0; i < analysis.sections.length; i++) {
    const section = analysis.sections[i]
    const label = section.label
    const atMs = snapToBar(section.startMs, analysis, beatsPerBar)
    const patternId = uniqueEspPattern(label, section.energy, usedEsp, i)
    cues.push({
      id: crypto.randomUUID(),
      atMs,
      ledPatternId: patternId,
      label,
      dmxLook: dmxLookForSection(label, section.energy),
      dmx: dmxForSection(patternId, section.energy)
    })
  }

  if (cues.length === 0 || cues[0].atMs > 0) {
    cues.unshift({
      id: crypto.randomUUID(),
      atMs: 0,
      ledPatternId: 2,
      label: 'start',
      dmxLook: 'live',
      dmx: dmxForSection(2, 0.45)
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
