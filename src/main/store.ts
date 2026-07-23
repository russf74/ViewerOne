import Store from 'electron-store'
import type { AppState, SetlistItem } from '../shared/types.js'
import {
  clampLedBrightness,
  clampLedPatternId,
  LED_DEFAULT_BRIGHTNESS,
  RANDOM_LED_PATTERN_ID,
  songLedPatternForIndex
} from '../shared/ledPatterns.js'

type AppStore = Store<AppState>

const defaults: AppState = {
  fxMuted: false,
  setlist: [],
  currentSongId: null,
  esp32Enabled: false,
  ledBrightness: LED_DEFAULT_BRIGHTNESS,
  ledExternalPower: false
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
    return {
      id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
      program: typeof r.program === 'number' ? r.program : 0,
      title: String(r.title ?? ''),
      year,
      ledPattern: clampLedPatternId(
        r.ledPattern !== undefined ? r.ledPattern : RANDOM_LED_PATTERN_ID
      )
    }
  })
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
    setlist: normalizeSetlist(store.get('setlist')),
    currentSongId: (store.get('currentSongId') as string | null | undefined) ?? null,
    esp32Enabled: Boolean(store.get('esp32Enabled')),
    ledBrightness,
    ledExternalPower
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
    title: partial?.title ?? '',
    year: partial?.year ?? '',
    ledPattern: clampLedPatternId(partial?.ledPattern ?? RANDOM_LED_PATTERN_ID)
  }
}
