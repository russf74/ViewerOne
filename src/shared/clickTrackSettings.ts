import type { ClickTrackSettings } from '../shared/types.js'

export const DEFAULT_CLICK_TRACK: ClickTrackSettings = {
  generateWav: true,
  liveMidiEnabled: false,
  midiChannel: 10,
  midiNote: 37,
  accentNote: 39,
  accentEvery: 4,
  velocity: 90,
  accentVelocity: 110,
  countInBars: 1,
  volume: 0.55,
  accentVolume: 0.95
}

export function normalizeClickTrackSettings(raw: unknown): ClickTrackSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLICK_TRACK }
  const r = raw as Partial<ClickTrackSettings>
  const clamp7 = (v: unknown, fb: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(127, Math.round(n))) : fb
  }
  const clampCh = (v: unknown, fb: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(1, Math.min(16, Math.round(n))) : fb
  }
  return {
    generateWav: r.generateWav !== undefined ? Boolean(r.generateWav) : DEFAULT_CLICK_TRACK.generateWav,
    liveMidiEnabled:
      r.liveMidiEnabled !== undefined ? Boolean(r.liveMidiEnabled) : DEFAULT_CLICK_TRACK.liveMidiEnabled,
    midiChannel: clampCh(r.midiChannel, DEFAULT_CLICK_TRACK.midiChannel),
    midiNote: clamp7(r.midiNote, DEFAULT_CLICK_TRACK.midiNote),
    accentNote: clamp7(r.accentNote, DEFAULT_CLICK_TRACK.accentNote),
    accentEvery:
      r.accentEvery !== undefined && Number.isFinite(Number(r.accentEvery))
        ? Math.max(1, Math.round(Number(r.accentEvery)))
        : DEFAULT_CLICK_TRACK.accentEvery,
    velocity: clamp7(r.velocity, DEFAULT_CLICK_TRACK.velocity),
    accentVelocity: clamp7(r.accentVelocity, DEFAULT_CLICK_TRACK.accentVelocity),
    countInBars:
      r.countInBars !== undefined && Number.isFinite(Number(r.countInBars))
        ? Math.max(0, Math.min(4, Math.round(Number(r.countInBars))))
        : DEFAULT_CLICK_TRACK.countInBars,
    volume:
      r.volume !== undefined && Number.isFinite(Number(r.volume))
        ? Math.max(0, Math.min(1, Number(r.volume)))
        : DEFAULT_CLICK_TRACK.volume,
    accentVolume:
      r.accentVolume !== undefined && Number.isFinite(Number(r.accentVolume))
        ? Math.max(0, Math.min(1, Number(r.accentVolume)))
        : DEFAULT_CLICK_TRACK.accentVolume
  }
}
