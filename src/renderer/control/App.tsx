import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { AppState, MidiSpyEvent, MidiSpyRole, PublicState, SetlistItem } from '../../shared/types'
import { LED_USB_BRIGHTNESS_CAP } from '../../shared/ledPatterns'
import {
  calculateSetlistTiming,
  countNumberedArrangerSongs,
  formatSetlistSeconds,
  summarizeUnvisitedSetlist,
  scanIsGigReady
} from '../../shared/setlistTiming'
import {
  BRIDGED_MUTES,
  CUBASE_ALL_MUTE_CC,
  CUBASE_MUTE_CC,
  CUBASE_MUTE_CHANNEL,
  CUBASE_PIANO_MUTE_CC,
  CUBASE_SYNTH_MUTE_CC,
  MIXER_ALL_MUTE_CC,
  MIXER_MUTE_CC,
  MIXER_MUTE_CHANNEL
} from '../../shared/midiConfig'
import { SortableRow } from './SortableRow'
import { LightingCueEditor } from './LightingCueEditor'
import { Esp32Preview } from './Esp32Preview'

type StatusLine = { text: string; tone: 'ok' | 'warn' | 'error' }
type SpyFilter = 'all' | 'transport' | 'song' | 'mute'

const SPY_FILTERS: { id: SpyFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'transport', label: 'Transport only' },
  { id: 'song', label: 'Song' },
  { id: 'mute', label: 'Mute' }
]

function spyRoleMatchesFilter(
  role: MidiSpyRole | undefined,
  filter: SpyFilter,
  kind?: MidiSpyEvent['kind']
): boolean {
  // Clock heartbeat is noisy — hide from default All; Transport/Song/Mute stay focused.
  if (filter === 'all' && kind === 'clock') return false
  if (filter === 'all') return true
  if (filter === 'transport') return role === 'TRANSPORT'
  if (filter === 'song') return role === 'SONG'
  return role === 'MUTE'
}

function spyEventRole(ev: MidiSpyEvent): MidiSpyRole {
  return ev.role ?? 'OTHER'
}

const BTN_FLASH_MS = 450

/** Brief pulse so toolbar / settings clicks are visibly acknowledged. */
function flashButton(el: HTMLElement | null | undefined): void {
  if (!el) return
  el.classList.remove('btn-click-flash')
  // Force reflow so re-clicks restart the animation.
  void el.offsetWidth
  el.classList.add('btn-click-flash')
  window.setTimeout(() => el.classList.remove('btn-click-flash'), BTN_FLASH_MS)
}

function midiReconnectFeedback(state: PublicState): StatusLine {
  const { midi } = state
  const cubaseBits: string[] = []
  if (midi.cubaseInputName) cubaseBits.push(`in ${midi.cubaseInputOpen ? '✓' : '✗'} ${midi.cubaseInputName}`)
  else cubaseBits.push('in missing')
  if (midi.cubaseOutputName) cubaseBits.push(`out ${midi.cubaseOutputOpen ? '✓' : '✗'} ${midi.cubaseOutputName}`)
  else cubaseBits.push('out missing')

  const mixerBits: string[] = []
  if (midi.mixerInputName) mixerBits.push(`in ${midi.mixerInputOpen ? '✓' : '✗'} ${midi.mixerInputName}`)
  else mixerBits.push('in missing')
  if (midi.mixerOutputName) mixerBits.push(`out ${midi.mixerOutputOpen ? '✓' : '✗'} ${midi.mixerOutputName}`)
  else mixerBits.push('out missing')

  const cubaseOk = midi.cubaseInputOpen && midi.cubaseOutputOpen
  const mixerOk = midi.mixerInputOpen && midi.mixerOutputOpen
  const anyOpen = midi.cubaseInputOpen || midi.cubaseOutputOpen || midi.mixerInputOpen || midi.mixerOutputOpen

  if (!anyOpen) {
    return {
      text: 'MIDI reconnect: no ports open.',
      tone: 'error'
    }
  }
  if (cubaseOk && mixerOk) {
    return {
      text: `MIDI reconnected — Cubase: ${midi.cubaseInputName} ↔ ${midi.cubaseOutputName}; Mixer: ${midi.mixerInputName} ↔ ${midi.mixerOutputName}`,
      tone: 'ok'
    }
  }
  return {
    text: `MIDI reconnected (partial) — Cubase (${cubaseBits.join(', ')}); Mixer (${mixerBits.join(', ')})`,
    tone: 'warn'
  }
}

function cubaseStatusLine(state: PublicState): StatusLine {
  const { midi } = state
  if (!midi.cubaseInputName && !midi.cubaseOutputName) {
    return { text: 'not found', tone: 'error' }
  }
  if (!midi.cubaseInputName || !midi.cubaseOutputName || !midi.cubaseInputOpen || !midi.cubaseOutputOpen) {
    const inPart = midi.cubaseInputOpen
      ? midi.cubaseInputName
      : `couldn't open ${midi.cubaseInputName ?? 'missing'}`
    const outPart = midi.cubaseOutputOpen
      ? midi.cubaseOutputName
      : `couldn't open ${midi.cubaseOutputName ?? 'missing'}`
    return {
      text: `partially connected (in: ${inPart}, out: ${outPart})`,
      tone: 'warn'
    }
  }
  let text = `connected (${midi.cubaseInputName} ↔ ${midi.cubaseOutputName})`
  if (midi.cubaseLastSentCc) {
    const ago = midi.cubaseLastSentAgoMs ?? 0
    const agoText = ago < 1500 ? 'just now' : `${Math.round(ago / 1000)}s ago`
    text += ` — last sent mute ${agoText} (ch ${midi.cubaseLastSentCc.channel + 1}, CC ${midi.cubaseLastSentCc.controller}, val ${midi.cubaseLastSentCc.value})`
  }
  return { text, tone: 'ok' }
}

function cubaseLastPcLine(state: PublicState): StatusLine {
  const { midi } = state
  if (!midi.cubaseInputOpen) {
    return { text: 'input not open', tone: 'warn' }
  }
  if (midi.cubaseLastPc == null) {
    return { text: 'waiting for Program Change', tone: 'warn' }
  }
  const ago = midi.cubaseLastPcAgoMs ?? 0
  const agoText = ago < 1500 ? 'just now' : `${Math.round(ago / 1000)}s ago`
  return {
    text: `PC ${midi.cubaseLastPc} · ch ${midi.cubaseLastPcChannel ?? '?'} · ${agoText}`,
    tone: 'ok'
  }
}

function transportAgoText(agoMs: number | null | undefined): string {
  if (agoMs == null) return ''
  if (agoMs < 1500) return 'just now'
  return `${Math.round(agoMs / 1000)}s ago`
}

function spyAgeText(atMs: number, now: number): string {
  const ago = now - atMs
  if (ago < 1500) return 'now'
  if (ago < 60_000) return `${Math.round(ago / 1000)}s`
  return `${Math.round(ago / 60_000)}m`
}

function transportMapSummary(state: PublicState): string {
  const t = state.transportMidi
  const ch = t.channel === 0 ? 'any ch' : `ch ${t.channel}`
  const unit = t.mode === 'cc' ? 'CC' : 'note'
  return `${ch} ${unit} ${t.startNumber} Start / ${t.stopNumber} Stop · + MMC · + realtime`
}

function mixerStatusLine(state: PublicState): StatusLine {
  const { midi } = state
  if (!midi.mixerInputName && !midi.mixerOutputName) {
    return { text: 'not found', tone: 'error' }
  }
  if (!midi.mixerInputOpen || !midi.mixerOutputOpen) {
    const parts: string[] = []
    parts.push(midi.mixerInputOpen ? `in: ${midi.mixerInputName}` : `in: couldn't open ${midi.mixerInputName ?? 'missing'}`)
    parts.push(
      midi.mixerOutputOpen
        ? `out: ${midi.mixerOutputName}`
        : `out: couldn't open ${midi.mixerOutputName ?? 'missing'} (in use elsewhere, e.g. Cubase?)`
    )
    return { text: `partially connected (${parts.join(', ')})`, tone: 'warn' }
  }
  let text = `connected (${midi.mixerInputName} ↔ ${midi.mixerOutputName})`
  if (midi.mixerLastCc) {
    const ago = midi.mixerLastMessageAgoMs ?? 0
    const agoText = ago < 1500 ? 'just now' : `${Math.round(ago / 1000)}s ago`
    text += ` — last received ${agoText} (ch ${midi.mixerLastCc.channel + 1}, CC ${midi.mixerLastCc.controller}, val ${midi.mixerLastCc.value})`
  }
  if (midi.mixerLastSentCc) {
    const ago = midi.mixerLastSentAgoMs ?? 0
    const agoText = ago < 1500 ? 'just now' : `${Math.round(ago / 1000)}s ago`
    text += ` — last sent ${agoText} (ch ${midi.mixerLastSentCc.channel + 1}, CC ${midi.mixerLastSentCc.controller}, val ${midi.mixerLastSentCc.value})`
  }
  return { text, tone: 'ok' }
}

export function App() {
  const [state, setState] = useState<PublicState | null>(null)
  const [detailMode, setDetailMode] = useState(false)
  const [spyFilter, setSpyFilter] = useState<SpyFilter>('all')
  const [midiFeedback, setMidiFeedback] = useState<StatusLine | null>(null)
  const midiFeedbackTimer = useRef<number | null>(null)
  const bridgeOk = typeof window !== 'undefined' && typeof window.viewer !== 'undefined'

  const apply = useCallback((next: PublicState) => {
    setState(next)
  }, [])

  const showMidiFeedback = useCallback((line: StatusLine) => {
    setMidiFeedback(line)
    if (midiFeedbackTimer.current !== null) window.clearTimeout(midiFeedbackTimer.current)
    midiFeedbackTimer.current = window.setTimeout(() => {
      setMidiFeedback(null)
      midiFeedbackTimer.current = null
    }, 6000)
  }, [])

  useEffect(() => {
    return () => {
      if (midiFeedbackTimer.current !== null) window.clearTimeout(midiFeedbackTimer.current)
    }
  }, [])

  const setlistScrollRef = useRef<HTMLDivElement>(null)

  const onReconnectMidi = useCallback(
    async (btn: HTMLButtonElement) => {
      flashButton(btn)
      showMidiFeedback({ text: 'MIDI reconnecting…', tone: 'warn' })
      try {
        const next = await window.viewer.refreshMidi()
        apply(next)
        showMidiFeedback(midiReconnectFeedback(next))
      } catch {
        showMidiFeedback({ text: 'MIDI reconnect failed — see console / DevTools.', tone: 'error' })
      }
    },
    [apply, showMidiFeedback]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 }
    })
  )

  useEffect(() => {
    if (!bridgeOk) return
    let off: (() => void) | undefined
    void window.viewer.getState().then(setState)
    off = window.viewer.onState(setState)
    return () => off?.()
  }, [bridgeOk])

  useEffect(() => {
    if (!state?.currentSongId) return
    const root = setlistScrollRef.current
    if (!root) return
    const row = root.querySelector('.setlist-row.current')
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [state?.currentSongId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const a = document.activeElement
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return
      e.preventDefault()
      const p = e.key === 'ArrowUp' ? window.viewer.previewPrev() : window.viewer.previewNext()
      void p.then(apply)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply])

  const patchSettings = useCallback(
    async (patch: Partial<AppState>) => {
      const next = await window.viewer.patchSettings(patch)
      apply(next)
    },
    [apply]
  )

  const setSetlist = useCallback(
    async (items: SetlistItem[]) => {
      const next = await window.viewer.setSetlist(items)
      apply(next)
    },
    [apply]
  )

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      if (!state || !e.over || e.active.id === e.over.id) return
      const ids = state.setlist.map((r) => r.id)
      const oldIndex = ids.indexOf(String(e.active.id))
      const newIndex = ids.indexOf(String(e.over.id))
      if (oldIndex < 0 || newIndex < 0) return
      const nextItems = arrayMove(state.setlist, oldIndex, newIndex)
      await setSetlist(nextItems)
    },
    [state, setSetlist]
  )

  const updateRow = useCallback(
    (id: string, patch: Partial<Pick<SetlistItem, 'title' | 'length' | 'year' | 'ledPattern'>>) => {
      if (!state) return
      const nextItems = state.setlist.map((r) => (r.id === id ? { ...r, ...patch } : r))
      void setSetlist(nextItems)
    },
    [state, setSetlist]
  )

  const cubaseStatus = useMemo(() => (state ? cubaseStatusLine(state) : null), [state])
  const cubasePcStatus = useMemo(() => (state ? cubaseLastPcLine(state) : null), [state])
  const mixerStatus = useMemo(() => (state ? mixerStatusLine(state) : null), [state])
  const setlistTiming = useMemo(
    () => calculateSetlistTiming(state?.setlist ?? []),
    [state?.setlist]
  )
  const numberedArrangerSongs = useMemo(
    () => countNumberedArrangerSongs(state?.setlist ?? []),
    [state?.setlist]
  )
  const leftoverSetlist = useMemo(
    () => summarizeUnvisitedSetlist(state?.setlist ?? []),
    [state?.setlist]
  )
  const gigReady = useMemo(() => {
    const setlist = state?.setlist ?? []
    const gig = scanIsGigReady(setlist)
    // Only surface scan-phase error when the setlist itself is not gig-ready.
    // A completed walk with good lengths must stay gig-ready even if rewind-home failed.
    if (state?.arrangerScan.phase === 'error' && !gig.ready) {
      return {
        ready: false as const,
        blockers: gig.blockers.length
          ? gig.blockers
          : ['last Arranger scan was incomplete']
      }
    }
    return gig
  }, [state?.setlist, state?.arrangerScan.phase])
  const filteredSpy = useMemo(() => {
    const list = state?.midi.cubaseSpy ?? []
    return list.filter((ev) => spyRoleMatchesFilter(spyEventRole(ev), spyFilter, ev.kind))
  }, [state?.midi.cubaseSpy, spyFilter])

  // Keep “Ns ago” / spy ages fresh without waiting for another MIDI event.
  useEffect(() => {
    if (
      state?.midi.cubaseLastPc == null &&
      state?.transport.lastAtMs == null &&
      !(state?.midi.cubaseSpy?.length)
    ) {
      return
    }
    const id = window.setInterval(() => {
      void window.viewer.getState().then(setState)
    }, 1000)
    return () => window.clearInterval(id)
  }, [state?.midi.cubaseLastPc, state?.transport.lastAtMs, state?.midi.cubaseSpy?.length])

  if (!bridgeOk) {
    return (
      <div className="control-root control-root--bare">
        <h1>ViewerOne</h1>
        <p className="sub">
          The control panel could not connect to the app (preload bridge missing). Try{' '}
          <strong>View → Reload</strong> or <strong>View → Toggle Developer Tools</strong> and check the Console for
          errors.
        </p>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="control-root control-root--bare">
        <p className="sub">Loading…</p>
      </div>
    )
  }

  return (
    <div className="control-root">
      <div className="layout-top">
        <header className="top-header">
          <div className="top-header-text">
            <h1 className="app-title">ViewerOne</h1>
            <p className="sub">v{state.appVersion} · Live control</p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className={`detail-toggle${detailMode ? ' detail-toggle--active' : ''}`}
              aria-pressed={detailMode}
              onClick={(e) => {
                flashButton(e.currentTarget)
                setDetailMode((open) => !open)
              }}
            >
              Detail {detailMode ? 'On' : 'Off'}
            </button>
          </div>
        </header>

        <div className="top-columns">
          <div className="top-preview-col">
            <Esp32Preview state={state} detailMode={detailMode} />
          </div>

          <div className="top-settings-col">
            <div className="settings-card">
              <div className="settings-card-heading">
                <h2 className="settings-card-title">Live status</h2>
                <div className="serial-pill-group">
                  <span className={`serial-pill serial-pill--${state.esp32Display.connection}`}>
                    Display {state.esp32Display.connection}
                  </span>
                  <span className={`serial-pill serial-pill--${state.dmx.connection}`}>
                    DMX {state.dmx.connection}
                    {state.dmx.path ? ` ${state.dmx.path}` : ''}
                  </span>
                </div>
              </div>
              <div className="status-pills" aria-label="MIDI connection status">
                <span className={`status-pill status-pill--${cubaseStatus?.tone ?? 'warn'}`}>
                  <i aria-hidden="true" />
                  Cubase
                </span>
                <span className={`status-pill status-pill--${mixerStatus?.tone ?? 'warn'}`}>
                  <i aria-hidden="true" />
                  Mixer
                </span>
                <span className={`status-pill status-pill--${cubasePcStatus?.tone ?? 'warn'}`}>
                  PC {state.midi.cubaseLastPc ?? '—'}
                </span>
              </div>
              {detailMode ? (
                <div className="midi-status-list midi-status-list--detail">
                  <p className={`midi-status-row midi-status-row--${cubaseStatus?.tone ?? 'warn'}`}>
                    <strong>Cubase</strong> {cubaseStatus?.text}
                  </p>
                  <p className={`midi-status-row midi-status-row--${cubasePcStatus?.tone ?? 'warn'}`}>
                    <strong>Last Cubase PC</strong> {cubasePcStatus?.text}
                  </p>
                  <p className={`midi-status-row midi-status-row--${mixerStatus?.tone ?? 'warn'}`}>
                    <strong>Mixer</strong> {mixerStatus?.text}
                  </p>
                </div>
              ) : null}
              <div className="essential-controls">
                <label className="esp-enable esp-enable--inline">
                  <input
                    type="checkbox"
                    checked={state.fxMuted}
                    onChange={(e) => void patchSettings({ fxMuted: e.target.checked })}
                  />
                  <span>FX mute</span>
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={(e) => void onReconnectMidi(e.currentTarget)}
                >
                  Reconnect MIDI
                </button>
              </div>
              <p className="midi-reconnect-help">
                Cubase usually does not need restart; use Reconnect MIDI if ports were busy.
              </p>
              {detailMode ? (
                <p className="midi-reconnect-help">
                  Mute CCs on ch1 (Jump/Value): ALL/Group1 <strong>CC88</strong> and FX{' '}
                  <strong>CC85</strong> = 0 muted / 127 live; Synth <strong>CC86</strong> / Piano{' '}
                  <strong>CC87</strong> = inverted (127 muted / 0 live). Map Cubase Generic Remote
                  both ways on the loopMIDI pair. Mixer bridge: ALL ↔ X32 mute group 1 (ch2/CC80);
                  FX ↔ mute group 6 (ch2/CC85). Mute groups: 0=active/muted, 127=off (≠ bus
                  127=muted). Cubase ALL is CC88 (outside X32 MG 80–85; ≠ mixer CC80; not 86/87).
                </p>
              ) : null}
              <div className="transport-status" role="status" aria-live="polite">
                <div className="transport-status-row">
                  <span
                    className={`transport-pill transport-pill--${
                      state.transport.playing ? 'playing' : 'stopped'
                    }`}
                  >
                    <i aria-hidden="true" />
                    Cubase {state.transport.playing ? 'Playing' : 'Stopped'}
                  </span>
                  <span className="transport-meta">
                    {state.transport.lastSource
                      ? `Last ${state.transport.lastAction ?? 'event'} via ${state.transport.lastSource}${
                          state.transport.lastAtMs
                            ? ` · ${transportAgoText(Date.now() - state.transport.lastAtMs)}`
                            : ''
                        }`
                      : 'Waiting for Start/Stop'}
                  </span>
                </div>
                <p className="transport-countdown">
                  Remaining {state.countdown.display || '--:--'}
                  {state.countdown.running ? ' · counting' : ' · frozen'}
                </p>
                <p className="midi-reconnect-help">
                  MIDI in <strong>{state.midi.cubaseInputName ?? 'CubaseToViewerOne'}</strong>
                  {' · '}
                  {transportMapSummary(state)}
                </p>
                {state.midi.transportHint ? (
                  <p className="transport-hint" role="status">
                    {state.midi.transportHint}
                  </p>
                ) : null}
                {detailMode ? (
                  <div className="midi-spy" aria-label="Incoming Cubase MIDI activity">
                    <div className="midi-spy-heading">
                      <span>MIDI spy</span>
                      <span className="midi-spy-sub">
                        {state.midi.cubaseSpy.length || 0} on{' '}
                        {state.midi.cubaseInputName ?? 'CubaseToViewerOne'}
                      </span>
                    </div>
                    <p className="midi-spy-help">
                      Press Play/Stop in Cubase — look for lines tagged TRANSPORT. Song PCs and mute
                      CCs are normal and ignored for countdown.
                    </p>
                    <div className="midi-spy-filters" role="toolbar" aria-label="MIDI spy filter">
                      {SPY_FILTERS.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className={`midi-spy-filter${spyFilter === f.id ? ' midi-spy-filter--active' : ''}`}
                          aria-pressed={spyFilter === f.id}
                          onClick={() => setSpyFilter(f.id)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {state.midi.cubaseSpy.length === 0 ? (
                      <p className="midi-spy-empty">
                        No messages yet. If Play adds nothing tagged TRANSPORT, route Clock/MMC/Generic
                        Remote to this port.
                      </p>
                    ) : filteredSpy.length === 0 ? (
                      <p className="midi-spy-empty">
                        No {spyFilter === 'transport' ? 'TRANSPORT' : spyFilter} messages in the recent
                        list — switch to All or press Play/Stop.
                      </p>
                    ) : (
                      <ul className="midi-spy-list">
                        {[...filteredSpy].reverse().map((ev, i) => {
                          const role = spyEventRole(ev)
                          return (
                            <li
                              key={`${ev.atMs}-${ev.kind}-${role}-${i}`}
                              className={`midi-spy-item midi-spy-item--${ev.kind} midi-spy-item--role-${role.toLowerCase()}`}
                            >
                              <span className="midi-spy-age">{spyAgeText(ev.atMs, Date.now())}</span>
                              <span className={`midi-spy-role midi-spy-role--${role.toLowerCase()}`}>
                                {role}
                              </span>
                              <span className="midi-spy-summary">{ev.summary}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="midi-feedback-slot">
                {midiFeedback ? (
                  <p
                    className={`midi-status-row midi-status-row--flash midi-status-row--${midiFeedback.tone}`}
                    role="status"
                    aria-live="polite"
                  >
                    {midiFeedback.text}
                  </p>
                ) : null}
              </div>

              {detailMode ? (
                <>
                <section className="detail-section diagnostics-section" aria-labelledby="diagnostics-heading">
                  <h3 id="diagnostics-heading">Diagnostics</h3>
                  <div className="diagnostics-grid">
                    <div className="diagnostics-block">
                      <h4>MIDI ports</h4>
                      <ul className="diagnostics-list">
                        <li>
                          Cubase in:{' '}
                          {state.midi.cubaseInputOpen ? 'open' : 'closed'}
                          {state.midi.cubaseInputName ? ` · ${state.midi.cubaseInputName}` : ''}
                        </li>
                        <li>
                          Cubase out:{' '}
                          {state.midi.cubaseOutputOpen ? 'open' : 'closed'}
                          {state.midi.cubaseOutputName ? ` · ${state.midi.cubaseOutputName}` : ''}
                        </li>
                        <li>
                          Mixer in:{' '}
                          {state.midi.mixerInputOpen ? 'open' : 'closed'}
                          {state.midi.mixerInputName ? ` · ${state.midi.mixerInputName}` : ''}
                        </li>
                        <li>
                          Mixer out:{' '}
                          {state.midi.mixerOutputOpen ? 'open' : 'closed'}
                          {state.midi.mixerOutputName ? ` · ${state.midi.mixerOutputName}` : ''}
                        </li>
                      </ul>
                    </div>
                    <div className="diagnostics-block">
                      <h4>Last MIDI activity</h4>
                      <ul className="diagnostics-list">
                        <li>
                          Cubase PC:{' '}
                          {state.midi.cubaseLastPc != null
                            ? `PC ${state.midi.cubaseLastPc} · ch ${state.midi.cubaseLastPcChannel ?? '?'} · ${transportAgoText(state.midi.cubaseLastPcAgoMs)}`
                            : '—'}
                        </li>
                        <li>
                          Cubase last sent:{' '}
                          {state.midi.cubaseLastSentCc
                            ? `ch ${state.midi.cubaseLastSentCc.channel + 1} CC${state.midi.cubaseLastSentCc.controller}=${state.midi.cubaseLastSentCc.value} · ${transportAgoText(state.midi.cubaseLastSentAgoMs)}`
                            : '—'}
                        </li>
                        <li>
                          Mixer last RX:{' '}
                          {state.midi.mixerLastCc
                            ? `ch ${state.midi.mixerLastCc.channel + 1} CC${state.midi.mixerLastCc.controller}=${state.midi.mixerLastCc.value} · ${transportAgoText(state.midi.mixerLastMessageAgoMs)}`
                            : '—'}
                        </li>
                        <li>
                          Mixer last TX:{' '}
                          {state.midi.mixerLastSentCc
                            ? `ch ${state.midi.mixerLastSentCc.channel + 1} CC${state.midi.mixerLastSentCc.controller}=${state.midi.mixerLastSentCc.value} · ${transportAgoText(state.midi.mixerLastSentAgoMs)}`
                            : '—'}
                        </li>
                      </ul>
                    </div>
                    <div className="diagnostics-block">
                      <h4>ESP / display</h4>
                      <ul className="diagnostics-list">
                        <li>
                          Serial: {state.esp32Display.connection}
                          {state.esp32Enabled ? '' : ' (disabled)'}
                        </li>
                        <li>
                          Device:{' '}
                          {state.esp32Display.device !== 'unknown'
                            ? state.esp32Display.device
                            : '—'}
                          {state.esp32Display.model ? ` · ${state.esp32Display.model}` : ''}
                        </li>
                        <li>
                          Size:{' '}
                          {state.esp32Display.width && state.esp32Display.height
                            ? `${state.esp32Display.width}×${state.esp32Display.height}`
                            : '—'}
                        </li>
                        <li>Firmware: {state.esp32Display.fw ? `v${state.esp32Display.fw}` : '—'}</li>
                      </ul>
                    </div>
                    <div className="diagnostics-block">
                      <h4>Transport</h4>
                      <ul className="diagnostics-list">
                        <li>{state.transport.playing ? 'Playing' : 'Stopped'}</li>
                        <li>
                          Last source:{' '}
                          {state.transport.lastSource
                            ? `${state.transport.lastAction ?? 'event'} via ${state.transport.lastSource}${
                                state.transport.lastAtMs
                                  ? ` · ${transportAgoText(Date.now() - state.transport.lastAtMs)}`
                                  : ''
                              }`
                            : '—'}
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div className="diagnostics-block diagnostics-block--table">
                    <h4>Mute bridge map</h4>
                    <table className="diagnostics-table">
                      <thead>
                        <tr>
                          <th>Pad / group</th>
                          <th>Cubase</th>
                          <th>Mixer</th>
                        </tr>
                      </thead>
                      <tbody>
                        {BRIDGED_MUTES.map((b) => (
                          <tr key={b.id}>
                            <td>{b.id === 'all' ? 'ALL / Group1' : 'FX / Group6'}</td>
                            <td>
                              ch{CUBASE_MUTE_CHANNEL} CC{b.cubaseCc}
                            </td>
                            <td>
                              ch{MIXER_MUTE_CHANNEL} CC{b.mixerCc}
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td>Synth</td>
                          <td>
                            ch{CUBASE_MUTE_CHANNEL} CC{CUBASE_SYNTH_MUTE_CC}
                          </td>
                          <td>—</td>
                        </tr>
                        <tr>
                          <td>Piano</td>
                          <td>
                            ch{CUBASE_MUTE_CHANNEL} CC{CUBASE_PIANO_MUTE_CC}
                          </td>
                          <td>—</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="midi-reconnect-help">
                      FX Cubase CC{CUBASE_MUTE_CC} ↔ mixer CC{MIXER_MUTE_CC}; ALL Cubase CC
                      {CUBASE_ALL_MUTE_CC} ↔ mixer CC{MIXER_ALL_MUTE_CC}. Synth/Piano are
                      Cubase-only (no mixer bridge).
                    </p>
                  </div>
                </section>
                <section className="detail-section" aria-labelledby="transport-mapping-heading">
                  <h3 id="transport-mapping-heading">Transport MIDI mapping</h3>
                  <p className="midi-reconnect-help">
                    Defaults are ch16 note 60/61. MIDI realtime Start/Stop and MMC are always
                    accepted. Match whatever the MIDI spy shows when you press Play.
                  </p>
                  <div className="settings-fields settings-fields--midi">
                    <div className="field">
                      <label htmlFor="transport-mode">Message</label>
                      <select
                        id="transport-mode"
                        value={state.transportMidi.mode}
                        onChange={(e) =>
                          void patchSettings({
                            transportMidi: {
                              ...state.transportMidi,
                              mode: e.target.value === 'cc' ? 'cc' : 'note'
                            }
                          })
                        }
                      >
                        <option value="note">Note On</option>
                        <option value="cc">Control Change</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="transport-channel">Channel</label>
                      <select
                        id="transport-channel"
                        value={state.transportMidi.channel}
                        onChange={(e) =>
                          void patchSettings({
                            transportMidi: {
                              ...state.transportMidi,
                              channel: Number(e.target.value)
                            }
                          })
                        }
                      >
                        <option value={0}>Any</option>
                        {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                          <option key={ch} value={ch}>
                            {ch}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="transport-start">
                        Start {state.transportMidi.mode === 'note' ? 'note' : 'CC'}
                      </label>
                      <input
                        id="transport-start"
                        type="number"
                        min={0}
                        max={127}
                        value={state.transportMidi.startNumber}
                        onChange={(e) =>
                          void patchSettings({
                            transportMidi: {
                              ...state.transportMidi,
                              startNumber: Number(e.target.value)
                            }
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="transport-stop">
                        Stop {state.transportMidi.mode === 'note' ? 'note' : 'CC'}
                      </label>
                      <input
                        id="transport-stop"
                        type="number"
                        min={0}
                        max={127}
                        value={state.transportMidi.stopNumber}
                        onChange={(e) =>
                          void patchSettings({
                            transportMidi: {
                              ...state.transportMidi,
                              stopNumber: Number(e.target.value)
                            }
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="countdown-start-lead">Start lead (ms)</label>
                      <input
                        id="countdown-start-lead"
                        type="number"
                        min={0}
                        max={15000}
                        step={100}
                        value={state.countdownStartLeadMs}
                        title="Backdate full-length countdown start to absorb Cubase Start lag (auto-tunes at song boundaries while playing)"
                        onChange={(e) =>
                          void patchSettings({ countdownStartLeadMs: Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                  <p className="midi-reconnect-help">
                    Start lead compensates for Cubase Start arriving late vs the arranger block.
                    Default 2500 ms. If the counter still has leftover at song change while Playing,
                    ViewerOne blends the lead toward that leftover (0.5–10 s).
                  </p>
                </section>
                <section className="detail-section" aria-labelledby="arranger-mapping-heading">
                  <h3 id="arranger-mapping-heading">Arranger MIDI mapping</h3>
                <div className="settings-fields settings-fields--midi">
                  <div className="field">
                    <label htmlFor="arranger-mode">Message</label>
                    <select
                      id="arranger-mode"
                      value={state.arrangerMidi.mode}
                      disabled={state.arrangerScan.active}
                      onChange={(e) =>
                        void patchSettings({
                          arrangerMidi: {
                            ...state.arrangerMidi,
                            mode: e.target.value === 'cc' ? 'cc' : 'note'
                          }
                        })
                      }
                    >
                      <option value="note">Note On pulse</option>
                      <option value="cc">Control Change 127</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="arranger-channel">Channel</label>
                    <input
                      id="arranger-channel"
                      type="number"
                      min={1}
                      max={16}
                      value={state.arrangerMidi.channel}
                      disabled={state.arrangerScan.active}
                      onChange={(e) =>
                        void patchSettings({
                          arrangerMidi: { ...state.arrangerMidi, channel: Number(e.target.value) }
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="arranger-prev-number">Prev {state.arrangerMidi.mode === 'note' ? 'note' : 'CC'}</label>
                    <input
                      id="arranger-prev-number"
                      type="number"
                      min={0}
                      max={127}
                      value={state.arrangerMidi.prevNumber}
                      disabled={state.arrangerScan.active}
                      onChange={(e) =>
                        void patchSettings({
                          arrangerMidi: { ...state.arrangerMidi, prevNumber: Number(e.target.value) }
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="arranger-next-number">Next {state.arrangerMidi.mode === 'note' ? 'note' : 'CC'}</label>
                    <input
                      id="arranger-next-number"
                      type="number"
                      min={0}
                      max={127}
                      value={state.arrangerMidi.nextNumber}
                      disabled={state.arrangerScan.active}
                      onChange={(e) =>
                        void patchSettings({
                          arrangerMidi: { ...state.arrangerMidi, nextNumber: Number(e.target.value) }
                        })
                      }
                    />
                  </div>
                </div>
                </section>
                </>
              ) : null}
            </div>

            {detailMode ? (
              <section className="settings-card hardware-settings" aria-labelledby="hardware-settings-heading">
                <h2 className="settings-card-title" id="hardware-settings-heading">
                  Display + LED + DMX
                </h2>
                <div className="settings-fields settings-fields--esp">
                  <label className="esp-enable">
                    <input
                      type="checkbox"
                      checked={state.esp32Enabled}
                      onChange={(e) => void patchSettings({ esp32Enabled: e.target.checked })}
                    />
                    <span>Enable USB serial to ESP32</span>
                  </label>
                  <label className="esp-enable">
                    <input
                      type="checkbox"
                      checked={state.ledExternalPower}
                      onChange={(e) => void patchSettings({ ledExternalPower: e.target.checked })}
                    />
                    <span>LEDs powered from external 5V PSU</span>
                  </label>
                  <div className="field led-brightness-field">
                    <label htmlFor="led-brightness">
                      LED brightness{' '}
                      <span className="led-bri-value">
                        {state.ledBrightness}
                        {!state.ledExternalPower ? ` / max ${LED_USB_BRIGHTNESS_CAP} (USB)` : ' / 255'}
                      </span>
                    </label>
                    <input
                      id="led-brightness"
                      type="range"
                      min={0}
                      max={state.ledExternalPower ? 255 : LED_USB_BRIGHTNESS_CAP}
                      value={state.ledBrightness}
                      onChange={(e) => void patchSettings({ ledBrightness: Number(e.target.value) })}
                    />
                    {!state.ledExternalPower ? (
                      <p className="settings-hint">
                        USB/ESP power: brightness capped at {LED_USB_BRIGHTNESS_CAP}. Tick external PSU for full range.
                      </p>
                    ) : null}
                  </div>
                  <p className="settings-hint">
                    DMXIS is always on: Freedom Stick 48-CH pixels at 97–144, PowerDome 10-CH at 1.
                    Set each stick to 48CH / d097 (not 8-CH). PC 125 blackout, PC 126 dim royal blue, PC 127
                    follows ESP (random rotates every 10s).
                  </p>
                  <div className="lighting-director-panel">
                    <h3 className="settings-subheading">Lighting Director (sidecar)</h3>
                    <p className="settings-hint">
                      Opt-in only — does not change Cubase playback or normal PC 127 behaviour until
                      enabled. Analyze captures <strong>real Cubase output</strong> (your tempo/key
                      edits, cuts, and repeats are baked in).
                    </p>
                    <label className="esp-enable">
                      <input
                        type="checkbox"
                        checked={state.lightingDirectorEnabled}
                        onChange={(e) =>
                          void patchSettings({ lightingDirectorEnabled: e.target.checked })
                        }
                      />
                      <span>Enable PC 127 timed lighting programs at the gig</span>
                    </label>
                    <label className="esp-enable">
                      <input
                        type="checkbox"
                        checked={state.liveAudioSyncEnabled}
                        onChange={(e) =>
                          void patchSettings({ liveAudioSyncEnabled: e.target.checked })
                        }
                      />
                      <span>Live beat sync during show (loopback nudge)</span>
                    </label>
                    <div className="field">
                      <label htmlFor="loopback-device">Loopback device (Stereo Mix name)</label>
                      <input
                        id="loopback-device"
                        className="text-input"
                        type="text"
                        value={state.lightingLoopbackDevice}
                        onChange={(e) =>
                          void patchSettings({ lightingLoopbackDevice: e.target.value })
                        }
                        placeholder="Stereo Mix"
                      />
                    </div>
                    {state.lightingAnalyze.active ? (
                      <p className="settings-hint lighting-director-live">
                        Cubase analyze: {state.lightingAnalyze.message}
                      </p>
                    ) : null}
                    {state.lightingDirector.active ? (
                      <p className="settings-hint lighting-director-live">
                        Live: {state.lightingDirector.activeCueLabel ?? '—'} · pattern{' '}
                        {state.lightingDirector.activePatternId ?? '—'} ·{' '}
                        {Math.round(state.lightingDirector.performanceMs / 1000)}s
                        {state.lightingDirector.syncOffsetMs
                          ? ` · sync ${state.lightingDirector.syncOffsetMs > 0 ? '+' : ''}${state.lightingDirector.syncOffsetMs}ms`
                          : ''}
                      </p>
                    ) : null}
                    {state.lightingDirector.analyzeError ? (
                      <p className="settings-hint settings-hint--warn">
                        {state.lightingDirector.analyzeError}
                      </p>
                    ) : null}
                    <LightingCueEditor
                      row={
                        state.currentSongId
                          ? state.setlist.find((r) => r.id === state.currentSongId) ?? null
                          : null
                      }
                      onSave={(program) => {
                        const row = state.currentSongId
                          ? state.setlist.find((r) => r.id === state.currentSongId)
                          : null
                        if (!row) return
                        void window.viewer.setLightingProgram(row.id, program).then(apply)
                      }}
                    />
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>

      <section className="setlist-shell" aria-label="Setlist">
        <div className="setlist-toolbar">
          <h2
            className="setlist-heading"
            title="Rows = every setlist entry. Numbered = CrowPanel total (scanned arranger songs, excluding INTRO/OUTRO/SOUNDCHECK and unvisited retained rows)."
          >
            Setlist ({state.setlist.length} rows · {numberedArrangerSongs} numbered)
          </h2>
          <div className="setlist-preview-nav">
            <button
              type="button"
              className="setlist-step-btn"
              title="Previous song — preview only (no MIDI to Cubase)"
              disabled={state.setlist.length === 0}
              onClick={(e) => {
                flashButton(e.currentTarget)
                void window.viewer.previewPrev().then(apply)
              }}
            >
              ↑ Prev
            </button>
            <button
              type="button"
              className="setlist-step-btn"
              title="Next song — preview only (no MIDI to Cubase)"
              disabled={state.setlist.length === 0}
              onClick={(e) => {
                flashButton(e.currentTarget)
                void window.viewer.previewNext().then(apply)
              }}
            >
              ↓ Next
            </button>
          </div>
          <div className="setlist-preview-nav arranger-controls">
            <button
              type="button"
              className="setlist-step-btn"
              disabled={state.arrangerScan.active || !state.midi.cubaseOutputOpen}
              onClick={(e) => {
                flashButton(e.currentTarget)
                void window.viewer.arrangerPrev().then(apply)
              }}
            >
              Arranger Prev
            </button>
            <button
              type="button"
              className="setlist-step-btn"
              disabled={state.arrangerScan.active || !state.midi.cubaseOutputOpen}
              onClick={(e) => {
                flashButton(e.currentTarget)
                void window.viewer.arrangerNext().then(apply)
              }}
            >
              Arranger Next
            </button>
            {state.arrangerScan.active ? (
              <button
                type="button"
                className="setlist-step-btn"
                onClick={(e) => {
                  flashButton(e.currentTarget)
                  void window.viewer.cancelArrangerScan().then(apply)
                }}
              >
                Cancel Scan
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="primary setlist-step-btn"
                  title="Walk Arranger chain for song order, then click each timeline Arranger event and read Length from Cubase (Info Line Name must match)."
                  disabled={!state.midi.cubaseInputOpen || !state.midi.cubaseOutputOpen}
                  onClick={(e) => {
                    flashButton(e.currentTarget)
                    void window.viewer.scanArranger().then(apply)
                  }}
                >
                  Scan Arranger
                </button>
                <button
                  type="button"
                  className="setlist-step-btn"
                  title="Select the Arranger event in Cubase first (Info Line Name must match). Then grab Length. Keeps the previous length if Name does not match."
                  disabled={!state.currentSongId || state.arrangerScan.active}
                  onClick={(e) => {
                    flashButton(e.currentTarget)
                    void window.viewer.grabCubaseLength().then(apply)
                  }}
                >
                  Grab Length
                </button>
              </>
            )}
            <span className={`arranger-progress arranger-progress--${state.arrangerScan.phase}`} role="status">
              {state.arrangerScan.message}
              {state.arrangerScan.active ? ` (${state.arrangerScan.collected} found)` : ''}
            </span>
          </div>
          <p
            className="setlist-totals"
            role="status"
            aria-live="polite"
            title="Duration sums scanned Arranger rows only (same songs as the numbered count). Leftover rows from a previous setlist marked “not in arranger” are excluded."
          >
            Duration : Intro {formatSetlistSeconds(setlistTiming.intro)} - Main Set{' '}
            {formatSetlistSeconds(setlistTiming.main)} - Outro{' '}
            {formatSetlistSeconds(setlistTiming.outro)} - Total{' '}
            {formatSetlistSeconds(setlistTiming.total)}
            {leftoverSetlist.withLength > 0 ? (
              <span className="setlist-totals-leftover">
                {' '}
                · {leftoverSetlist.rows} leftover not in arranger excluded (
                {formatSetlistSeconds(leftoverSetlist.seconds)})
              </span>
            ) : null}
            {!gigReady.ready ? (
              <span className="setlist-totals-missing">
                {' '}
                · not gig-ready
                {gigReady.blockers.length ? `: ${gigReady.blockers.join('; ')}` : ''}
              </span>
            ) : null}
          </p>
        </div>
        <div className="setlist-header">
          <span />
          <span title="Position from the last successful Arranger scan">Arranger</span>
          <span>PC</span>
          <span>Title</span>
          <span>Song length</span>
          <span>Year</span>
          <span className="setlist-h-pattern">Pattern</span>
          <span className="setlist-h-track">Track</span>
          <span />
        </div>
        <div className="setlist-scroll" ref={setlistScrollRef}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
            <SortableContext items={state.setlist.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              {state.setlist.map((item) => (
                <SortableRow
                  key={item.id}
                  item={item}
                  isCurrent={item.id === state.currentSongId}
                  isAnalyzing={state.lightingDirector.analyzingSongId === item.id}
                  onChange={(patch) => updateRow(item.id, patch)}
                  onRemove={() => void window.viewer.removeSong(item.id).then(apply)}
                  onPickBackingTrack={() =>
                    void window.viewer.pickBackingTrack(item.id).then(apply)
                  }
                  onAnalyzeLighting={() =>
                    void window.viewer.analyzeSongLighting(item.id).then(apply)
                  }
                  onActivateRow={() => void window.viewer.selectSong(item.id).then(apply)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="setlist-footer">
          {state.setlist.length === 0 ? (
            <p className="setlist-hint">
              Add songs manually or scan the Cubase Arranger.
            </p>
          ) : (
            <p className="setlist-hint">Drag to reorder · click a row to preview.</p>
          )}
          <button
            type="button"
            className="primary setlist-step-btn"
            title="Play each arranger song in Cubase once and record what you actually hear (tempo/key edits included). Requires Stereo Mix enabled."
            disabled={
              state.lightingAnalyze.active ||
              state.arrangerScan.active ||
              !state.midi.cubaseInputOpen ||
              !state.midi.cubaseOutputOpen
            }
            onClick={(e) => {
              flashButton(e.currentTarget)
              void window.viewer.analyzeLightingFromCubase().then(apply)
            }}
          >
            Analyze from Cubase
          </button>
          {state.lightingAnalyze.active ? (
            <button
              type="button"
              className="setlist-step-btn"
              onClick={(e) => {
                flashButton(e.currentTarget)
                void window.viewer.cancelLightingAnalyze().then(apply)
              }}
            >
              Cancel analyze
            </button>
          ) : null}
          <button
            type="button"
            className="setlist-step-btn"
            title="Legacy: analyze manually picked MP3 files (does not reflect Cubase tempo/key edits)"
            disabled={Boolean(state.lightingDirector.analyzingSongId) || state.lightingAnalyze.active}
            onClick={(e) => {
              flashButton(e.currentTarget)
              void window.viewer.analyzeAllLighting().then(apply)
            }}
          >
            Analyze external files
          </button>
          <button
            type="button"
            className="primary setlist-add-btn"
            onClick={(e) => {
              flashButton(e.currentTarget)
              void window.viewer.addSong().then(apply)
            }}
          >
            + Add song
          </button>
        </div>
      </section>
    </div>
  )
}
