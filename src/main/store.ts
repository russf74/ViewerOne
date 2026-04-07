import Store from 'electron-store'
import type { AppState, CcButtonSettings, CcMuteOutMode, SetlistItem, TransportSettings } from '../shared/types.js'

type AppStore = InstanceType<typeof Store>

const defaultTransport: TransportSettings = {
  mode: 'note',
  channel: 16,
  startNote: 60,
  stopNote: 61
}

/** X32 mute groups: CC 0 = muted, 127 = unmuted (absolute). */
const defaultCc = (cc: number, channel = 1, outMode: CcMuteOutMode = 'absolute'): CcButtonSettings => ({
  channel,
  cc,
  valueOn: 0,
  valueOff: 127,
  outMode
})

/**
 * X32 Remote: Mic CC 80, FX CC 85, ch 1 — value 0 when mute engaged, 127 when unmuted.
 */
const defaults: AppState = {
  midiInputName: null,
  midiOutputName: null,
  programChangeChannel: 1,
  transport: defaultTransport,
  muteAll: defaultCc(80, 1),
  muteFx: defaultCc(85, 1),
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
  let muteAll = store.get('muteAll') as CcButtonSettings
  let muteFx = store.get('muteFx') as CcButtonSettings
  /** One-time fix: mistaken CC 22/23 → correct X32 mapping 80/85 */
  if (muteAll.cc === 22 && muteFx.cc === 23) {
    muteAll = { ...muteAll, cc: 80 }
    muteFx = { ...muteFx, cc: 85 }
    store.set('muteAll', muteAll)
    store.set('muteFx', muteFx)
  }
  /** Legacy toggle127 / 127·0 → X32 polarity 0=mute 127=unmute, absolute */
  const migratePolarity = (m: CcButtonSettings): CcButtonSettings => {
    const legacy =
      m.outMode === 'toggle127' || (m.outMode === undefined && m.valueOn === 127 && m.valueOff === 0)
    if (legacy) {
      return { ...m, valueOn: 0, valueOff: 127, outMode: 'absolute' }
    }
    return m
  }
  const nextAll = migratePolarity(muteAll)
  const nextFx = migratePolarity(muteFx)
  if (
    nextAll.valueOn !== muteAll.valueOn ||
    nextAll.valueOff !== muteAll.valueOff ||
    nextAll.outMode !== muteAll.outMode
  ) {
    muteAll = nextAll
    store.set('muteAll', muteAll)
  }
  if (
    nextFx.valueOn !== muteFx.valueOn ||
    nextFx.valueOff !== muteFx.valueOff ||
    nextFx.outMode !== muteFx.outMode
  ) {
    muteFx = nextFx
    store.set('muteFx', muteFx)
  }
  return {
    midiInputName: store.get('midiInputName'),
    midiOutputName: store.get('midiOutputName'),
    programChangeChannel: store.get('programChangeChannel'),
    transport: store.get('transport'),
    muteAll,
    muteFx,
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
