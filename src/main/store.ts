import Store from 'electron-store'
import type { AppState, ArrangerMidiMapping, SetlistItem } from '../shared/types.js'
import {
  clampLedBrightness,
  clampLedPatternId,
  LED_DEFAULT_BRIGHTNESS,
  RANDOM_LED_PATTERN_ID,
  songLedPatternForIndex
} from '../shared/ledPatterns.js'
import { normalizeSongLength } from '../shared/setlistTiming.js'

type AppStore = Store<AppState>

const defaults: AppState = {
  fxMuted: false,
  allMuted: false,
  setlist: [],
  currentSongId: null,
  esp32Enabled: false,
  ledBrightness: LED_DEFAULT_BRIGHTNESS,
  ledExternalPower: false,
  arrangerMidi: {
    mode: 'note',
    channel: 16,
    prevNumber: 62,
    nextNumber: 63
  }
}

export function createAppStore(): AppStore {
  return new Store<AppState>({
    name: 'viewer-one-config',
    defaults
  })
}

function normalizeSetlist(list: unknown): SetlistItem[] {
  if (!Array.isArray(list)) return []
  return list.map((row) => {
    const r = row as SetlistItem & { chords?: string; live?: boolean }
    const year = String(r.year ?? r.chords ?? '')
    const arrangerIndex =
      typeof r.arrangerIndex === 'number' && Number.isFinite(r.arrangerIndex)
        ? Math.max(1, Math.round(r.arrangerIndex))
        : null
    return {
      id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
      program: typeof r.program === 'number' ? r.program : 0,
      arrangerIndex,
      title: String(r.title ?? ''),
      length: normalizeSongLength(r.length),
      year,
      ledPattern: clampLedPatternId(
        r.ledPattern !== undefined ? r.ledPattern : RANDOM_LED_PATTERN_ID
      )
    }
  })
}

function clampMidi7(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(127, Math.round(parsed))) : fallback
}

function normalizeArrangerMidi(value: unknown): ArrangerMidiMapping {
  const raw = value && typeof value === 'object' ? (value as Partial<ArrangerMidiMapping>) : {}
  return {
    mode: raw.mode === 'cc' ? 'cc' : 'note',
    channel: Math.max(1, Math.min(16, Math.round(Number(raw.channel) || 16))),
    prevNumber: clampMidi7(raw.prevNumber, 62),
    nextNumber: clampMidi7(raw.nextNumber, 63)
  }
}

/** Assign every song to random (20) — sequential rotate of busy patterns on ESP. */
export function assignLedPatternsByOrder(items: SetlistItem[]): SetlistItem[] {
  return items.map((row) => ({
    ...row,
    ledPattern: songLedPatternForIndex()
  }))
}

export function getState(store: AppStore): AppState {
  const ledExternalPower = Boolean(store.get('ledExternalPower') ?? false)
  const ledBrightness = clampLedBrightness(
    store.get('ledBrightness') ?? LED_DEFAULT_BRIGHTNESS,
    ledExternalPower
  )
  return {
    fxMuted: Boolean(store.get('fxMuted')),
    allMuted: Boolean(store.get('allMuted')),
    setlist: normalizeSetlist(store.get('setlist')),
    currentSongId: (store.get('currentSongId') as string | null | undefined) ?? null,
    esp32Enabled: Boolean(store.get('esp32Enabled')),
    ledBrightness,
    ledExternalPower,
    arrangerMidi: normalizeArrangerMidi(store.get('arrangerMidi'))
  }
}

export function setState(store: AppStore, patch: Partial<AppState>): void {
  for (const key of Object.keys(patch) as (keyof AppState)[]) {
    const v = patch[key]
    if (v !== undefined) store.set(key, v as never)
  }
}

export function newSetlistItem(partial?: Partial<SetlistItem>): SetlistItem {
  return {
    id: crypto.randomUUID(),
    program: partial?.program ?? 0,
    arrangerIndex: partial?.arrangerIndex ?? null,
    title: partial?.title ?? '',
    length: normalizeSongLength(partial?.length),
    year: partial?.year ?? '',
    ledPattern: clampLedPatternId(partial?.ledPattern ?? RANDOM_LED_PATTERN_ID)
  }
}
