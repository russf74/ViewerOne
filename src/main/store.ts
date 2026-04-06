import Store from 'electron-store'
import type { AppState, SetlistItem } from '../shared/types.js'

type AppStore = InstanceType<typeof Store>

const defaultTransport: TransportSettings = {
  mode: 'note',
  channel: 16,
  startNote: 60,
  stopNote: 61
}

const defaultCc = (cc: number): CcButtonSettings => ({
  channel: 1,
  cc,
  valueOn: 127,
  valueOff: 0
})

const defaults: AppState = {
  midiInputName: null,
  midiOutputName: null,
  programChangeChannel: 1,
  transport: defaultTransport,
  muteAll: defaultCc(22),
  muteFx: defaultCc(23),
  setlist: [],
  currentSongId: null
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
    const r = row as SetlistItem
    return {
      ...r,
      live: typeof r.live === 'boolean' ? r.live : true
    }
  })
}

export function getState(store: AppStore): AppState {
  return {
    midiInputName: store.get('midiInputName'),
    midiOutputName: store.get('midiOutputName'),
    programChangeChannel: store.get('programChangeChannel'),
    transport: store.get('transport'),
    muteAll: store.get('muteAll'),
    muteFx: store.get('muteFx'),
    setlist: normalizeSetlist(store.get('setlist')),
    currentSongId: (store.get('currentSongId') as string | null | undefined) ?? null
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
    chords: partial?.chords ?? '',
    live: typeof partial?.live === 'boolean' ? partial.live : true
  }
}
