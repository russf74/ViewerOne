import type { SongAudioAnalysis, SongSectionLabel } from './audioAnalysis.js'
import { clampLedPatternId } from './ledPatterns.js'

export type LightingCue = {
  /** Milliseconds from song start (performance clock). */
  atMs: number
  ledPatternId: number
  label?: string
  /** Optional brightness override 0–255; null = use settings. */
  brightness?: number
}

export type LightingProgram = {
  version: 1
  generatedAt: string
  cues: LightingCue[]
  /** Source analysis BPM at generation time. */
  bpm: number
}

/** Pattern palette mapped by section energy / role. */
const SECTION_PATTERN: Record<SongSectionLabel, number> = {
  intro: 2, // dual comet
  verse: 3, // ocean
  prechorus: 8, // neon pulse
  chorus: 16, // prism spin
  bridge: 12, // laser sweep
  breakdown: 21, // static low blue
  drop: 18, // color bomb
  outro: 0, // knight rider
  unknown: 20 // random
}

const HIGH_ENERGY_BOOST: Record<SongSectionLabel, number | null> = {
  intro: null,
  verse: null,
  prechorus: 13, // bass pulse on build
  chorus: 11, // disco ball
  bridge: 15, // hyper chase
  breakdown: null,
  drop: 10, // strobe wave
  outro: null,
  unknown: null
}

function patternForSection(label: SongSectionLabel, energy: number): number {
  if (energy > 0.85 && (label === 'chorus' || label === 'drop')) {
    return HIGH_ENERGY_BOOST[label] ?? SECTION_PATTERN[label]
  }
  if (energy < 0.3 && label !== 'outro' && label !== 'intro') {
    return SECTION_PATTERN.breakdown
  }
  return SECTION_PATTERN[label] ?? 20
}

/**
 * Build a timed lighting program from offline audio analysis.
 * Adds bar-aligned accent cues on chorus/drop entries.
 */
export function buildLightingProgram(analysis: SongAudioAnalysis): LightingProgram {
  const cues: LightingCue[] = []
  const beatMs = 60000 / Math.max(60, analysis.bpm)

  for (const section of analysis.sections) {
    const patternId = clampLedPatternId(patternForSection(section.label, section.energy))
    cues.push({
      atMs: section.startMs,
      ledPatternId: patternId,
      label: section.label
    })

    // Accent flash one beat into high-energy sections.
    if (section.energy > 0.75 && (section.label === 'chorus' || section.label === 'drop')) {
      cues.push({
        atMs: Math.round(section.startMs + beatMs),
        ledPatternId: clampLedPatternId(18),
        label: `${section.label} hit`
      })
    }
  }

  // Ensure we always open with something sensible.
  if (cues.length === 0 || cues[0].atMs > 0) {
    cues.unshift({ atMs: 0, ledPatternId: 2, label: 'start' })
  }

  cues.sort((a, b) => a.atMs - b.atMs)

  // De-dupe consecutive identical patterns.
  const compact: LightingCue[] = []
  for (const cue of cues) {
    const prev = compact[compact.length - 1]
    if (prev && prev.ledPatternId === cue.ledPatternId) continue
    compact.push(cue)
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    cues: compact,
    bpm: analysis.bpm
  }
}

/** Active cue at performance time `atMs` (last cue with atMs <= time). */
export function activeLightingCue(program: LightingProgram | undefined, atMs: number): LightingCue | null {
  if (!program?.cues?.length) return null
  let active: LightingCue | null = null
  for (const cue of program.cues) {
    if (cue.atMs <= atMs) active = cue
    else break
  }
  return active
}

/** Next cue after `atMs`, if any. */
export function nextLightingCue(program: LightingProgram | undefined, atMs: number): LightingCue | null {
  if (!program?.cues?.length) return null
  for (const cue of program.cues) {
    if (cue.atMs > atMs) return cue
  }
  return null
}
