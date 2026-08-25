import Store from 'electron-store'
import type { AppState, ArrangerMidiMapping, SetlistItem, TransportMidiMapping } from '../shared/types.js'
import { clampDmxChannel, normalizeDmxFixtureMode } from '../shared/dmx.js'
import {
  clampLedBrightness,
  clampLedPatternId,
  LED_DEFAULT_BRIGHTNESS,
  RANDOM_LED_PATTERN_ID,
  songLedPatternForIndex
} from '../shared/ledPatterns.js'
import { normalizeSongLength } from '../shared/setlistTiming.js'
import {
  CUBASE_TRANSPORT_CHANNEL,
  CUBASE_TRANSPORT_START_NOTE,
  CUBASE_TRANSPORT_STOP_NOTE
} from '../shared/midiConfig.js'

type AppStore = Store<AppState>

const defaults: AppState = {
  fxMuted: false,
  allMuted: false,
  synthMuted: false,
  pianoMuted: false,
  setlist: [],
  currentSongId: null,
  esp32Enabled: false,
  ledBrightness: LED_DEFAULT_BRIGHTNESS,
  ledExternalPower: false,
  dmxEnabled: false,
  dmxFixture1Channel: 97,
  dmxFixture1Mode: 'sound',
  dmxFixture2Channel: 1,
  dmxFixture2Mode: 'sound',
  arrangerMidi: {
    mode: 'note',
    channel: 16,
    prevNumber: 62,
    nextNumber: 63
  },
  transportMidi: {
    mode: 'note',
    channel: CUBASE_TRANSPORT_CHANNEL,
    startNumber: CUBASE_TRANSPORT_START_NOTE,
    stopNumber: CUBASE_TRANSPORT_STOP_NOTE
  },
  /** Cubase Start often arrives ~2s late vs arranger block — backdate full-length arms. */
  countdownStartLeadMs: 2500
}

/** Clamp persisted / patched start-lead (ms). */
export function clampCountdownStartLeadMs(value: unknown, fallback = 2500): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(15000, Math.round(parsed)))
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

function normalizeTransportMidi(value: unknown): TransportMidiMapping {
  const raw = value && typeof value === 'object' ? (value as Partial<TransportMidiMapping>) : {}
  const channelRaw = Number(raw.channel)
  // 0 = any channel; 1–16 = fixed. Invalid/missing → default ch 16.
  const channel = Number.isFinite(channelRaw)
    ? Math.max(0, Math.min(16, Math.round(channelRaw)))
    : CUBASE_TRANSPORT_CHANNEL
  return {
    mode: raw.mode === 'cc' ? 'cc' : 'note',
    channel,
    startNumber: clampMidi7(raw.startNumber, CUBASE_TRANSPORT_START_NOTE),
    stopNumber: clampMidi7(raw.stopNumber, CUBASE_TRANSPORT_STOP_NOTE)
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
    synthMuted: Boolean(store.get('synthMuted')),
    pianoMuted: Boolean(store.get('pianoMuted')),
    setlist: normalizeSetlist(store.get('setlist')),
    currentSongId: (store.get('currentSongId') as string | null | undefined) ?? null,
    esp32Enabled: Boolean(store.get('esp32Enabled')),
    ledBrightness,
    ledExternalPower,
    dmxEnabled: Boolean(store.get('dmxEnabled')),
    dmxFixture1Channel: clampDmxChannel(store.get('dmxFixture1Channel'), 97),
    dmxFixture1Mode: normalizeDmxFixtureMode(store.get('dmxFixture1Mode'), 'sound'),
    dmxFixture2Channel: clampDmxChannel(store.get('dmxFixture2Channel'), 1),
    dmxFixture2Mode: normalizeDmxFixtureMode(store.get('dmxFixture2Mode'), 'sound'),
    arrangerMidi: normalizeArrangerMidi(store.get('arrangerMidi')),
    transportMidi: normalizeTransportMidi(store.get('transportMidi')),
    countdownStartLeadMs: clampCountdownStartLeadMs(store.get('countdownStartLeadMs'), 2500)
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
