import type { SongAudioAnalysis, SongSection, SongSectionLabel } from './audioAnalysis.js'

const SECTION_LABELS: SongSectionLabel[] = [
  'intro',
  'verse',
  'prechorus',
  'chorus',
  'bridge',
  'breakdown',
  'drop',
  'outro',
  'unknown'
]

function normalizeSection(raw: unknown): SongSection | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SongSection>
  const label = SECTION_LABELS.includes(r.label as SongSectionLabel)
    ? (r.label as SongSectionLabel)
    : 'unknown'
  const startMs = Number(r.startMs)
  const energy = Number(r.energy)
  if (!Number.isFinite(startMs) || startMs < 0) return null
  return {
    label,
    startMs: Math.round(startMs),
    energy: Number.isFinite(energy) ? Math.max(0, Math.min(1, energy)) : 0.5
  }
}

export function normalizeSongAudioAnalysis(raw: unknown): SongAudioAnalysis | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<SongAudioAnalysis>
  const durationMs = Number(r.durationMs)
  const bpm = Number(r.bpm)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) return undefined

  const beatTimesMs = Array.isArray(r.beatTimesMs)
    ? r.beatTimesMs
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t >= 0)
        .map((t) => Math.round(t))
        .slice(0, 512)
    : []

  const sections = Array.isArray(r.sections)
    ? r.sections.map(normalizeSection).filter((s): s is SongSection => s != null)
    : []

  return {
    analyzedAt: typeof r.analyzedAt === 'string' ? r.analyzedAt : new Date().toISOString(),
    durationMs: Math.round(durationMs),
    sampleRate: Number.isFinite(Number(r.sampleRate)) ? Math.round(Number(r.sampleRate)) : 22050,
    bpm: Math.round(bpm),
    beatOffsetMs: Number.isFinite(Number(r.beatOffsetMs)) ? Math.round(Number(r.beatOffsetMs)) : 0,
    beatTimesMs,
    sections: sections.length > 0 ? sections : [{ label: 'unknown', startMs: 0, energy: 0.5 }],
    peakEnergy: Number.isFinite(Number(r.peakEnergy))
      ? Math.max(0, Math.min(1, Number(r.peakEnergy)))
      : 0.5
  }
}
