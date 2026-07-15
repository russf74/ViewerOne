import Store from 'electron-store'
import type { AppState, SetlistItem } from '../shared/types.js'

type AppStore = InstanceType<typeof Store>

const defaults: AppState = {
  fxMuted: false,
  setlist: [],
  currentSongId: null,
  esp32Enabled: false
}

type StoreSchema = AppState

export function createAppStore() {
  return new Store<StoreSchema>({
    name: 'viewer-one-config',
    defaults
  })
}

function normalizeSetlist(list: unknown): SetlistItem[] {
  if (!Array.isArray(list)) return []
  return list.map((row) => {
    const r = row as SetlistItem & { chords?: string }
    const year = String(r.year ?? r.chords ?? '')
    return {
      id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
      program: typeof r.program === 'number' ? r.program : 0,
      title: String(r.title ?? ''),
      year,
      live: typeof r.live === 'boolean' ? r.live : true
    }
  })
}

export function getState(store: AppStore): AppState {
  return {
    fxMuted: Boolean(store.get('fxMuted')),
    setlist: normalizeSetlist(store.get('setlist')),
    currentSongId: (store.get('currentSongId') as string | null | undefined) ?? null,
    esp32Enabled: Boolean(store.get('esp32Enabled'))
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
    live: typeof partial?.live === 'boolean' ? partial.live : true
  }
}
