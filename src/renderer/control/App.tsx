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
import type { AppState, PublicState, SetlistItem } from '../../shared/types'
import { SortableRow } from './SortableRow'
import { Esp32Preview } from './Esp32Preview'

type StatusLine = { text: string; tone: 'ok' | 'warn' | 'error' }

function cubaseStatusLine(state: PublicState): StatusLine {
  const { midi } = state
  if (!midi.cubaseInputName && !midi.cubaseOutputName) {
    return {
      text: 'not found — open loopMIDI and create cables named e.g. "CubaseToViewerOne" / "ViewerOneToCubase".',
      tone: 'error'
    }
  }
  if (!midi.cubaseInputName || !midi.cubaseOutputName) {
    return {
      text: `partially connected (in: ${midi.cubaseInputName ?? 'missing'}, out: ${midi.cubaseOutputName ?? 'missing'})`,
      tone: 'warn'
    }
  }
  let text = `connected (${midi.cubaseInputName} ↔ ${midi.cubaseOutputName})`
  if (midi.cubaseLastSentCc) {
    const ago = midi.cubaseLastSentAgoMs ?? 0
    const agoText = ago < 1500 ? 'just now' : `${Math.round(ago / 1000)}s ago`
    text += ` — last sent ${agoText} (ch ${midi.cubaseLastSentCc.channel + 1}, CC ${midi.cubaseLastSentCc.controller}, val ${midi.cubaseLastSentCc.value})`
  }
  return { text, tone: 'ok' }
}

function mixerStatusLine(state: PublicState): StatusLine {
  const { midi } = state
  if (!midi.mixerInputName && !midi.mixerOutputName) {
    return { text: 'not found — check the mixer is connected over USB.', tone: 'error' }
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
  const bridgeOk = typeof window !== 'undefined' && typeof window.viewer !== 'undefined'

  const apply = useCallback((next: PublicState) => {
    setState(next)
  }, [])

  const setlistScrollRef = useRef<HTMLDivElement>(null)

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
    (id: string, patch: Partial<Pick<SetlistItem, 'title' | 'year' | 'live'>>) => {
      if (!state) return
      const nextItems = state.setlist.map((r) => (r.id === id ? { ...r, ...patch } : r))
      void setSetlist(nextItems)
    },
    [state, setSetlist]
  )

  const cubaseStatus = useMemo(() => (state ? cubaseStatusLine(state) : null), [state])
  const mixerStatus = useMemo(() => (state ? mixerStatusLine(state) : null), [state])

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
            <p className="sub">Cubase program change → setlist · USB serial → ESP32 · settings saved automatically</p>
          </div>
        </header>

        <div className="top-columns">
          <div className="top-preview-col">
            <Esp32Preview state={state} />
          </div>

          <div className="top-settings-col">
            <div className="settings-card">
              <h2 className="settings-card-title">MIDI</h2>
              <p className="settings-card-lead">
                Cubase syncs song changes and its own auto-mute to ViewerOne over loopMIDI, and hears ViewerOne's mute
                changes back so it stays in sync. The mixer talks to ViewerOne directly, two-way, over its own USB
                MIDI port — mute stays in sync even with Cubase closed. Everything below is detected automatically —
                nothing to pick or configure.
              </p>
              <div className="midi-status-list">
                <p className={`midi-status-row midi-status-row--${cubaseStatus?.tone ?? 'warn'}`}>
                  <strong>Cubase</strong> {cubaseStatus?.text}
                </p>
                <p className={`midi-status-row midi-status-row--${mixerStatus?.tone ?? 'warn'}`}>
                  <strong>Mixer</strong> {mixerStatus?.text}
                </p>
              </div>
              <div className="settings-fields settings-fields--midi">
                <label className="esp-enable esp-enable--inline">
                  <input
                    type="checkbox"
                    checked={state.fxMuted}
                    onChange={(e) => void patchSettings({ fxMuted: e.target.checked })}
                  />
                  <span>FX muted (tint + CC out)</span>
                </label>
                <div className="field field-btn">
                  <label className="label-spacer" aria-hidden>
                    &nbsp;
                  </label>
                  <button type="button" className="btn-secondary" onClick={() => void window.viewer.refreshMidi().then(apply)}>
                    Reconnect MIDI
                  </button>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <h2 className="settings-card-title">ESP32 display</h2>
              <p className="settings-card-lead">
                JSON lines at <strong>115200</strong> baud — same as the preview. Flash <code>firmware/esp32-display</code>{' '}
                for your board. USB serial uses the CH340 / USB-serial device automatically (or the only COM port if
                there is just one); unplug and replug without restarting the app.
              </p>
              <div className="settings-fields settings-fields--esp">
                <label className="esp-enable">
                  <input
                    type="checkbox"
                    checked={state.esp32Enabled}
                    onChange={(e) => void patchSettings({ esp32Enabled: e.target.checked })}
                  />
                  <span>Enable USB serial to ESP32</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="setlist-shell" aria-label="Setlist">
        <div className="setlist-toolbar">
          <h2 className="setlist-heading">Setlist</h2>
          <div className="setlist-preview-nav">
            <button
              type="button"
              className="setlist-step-btn"
              title="Previous song — preview only (no MIDI to Cubase)"
              disabled={state.setlist.length === 0}
              onClick={() => void window.viewer.previewPrev().then(apply)}
            >
              ↑ Prev
            </button>
            <button
              type="button"
              className="setlist-step-btn"
              title="Next song — preview only (no MIDI to Cubase)"
              disabled={state.setlist.length === 0}
              onClick={() => void window.viewer.previewNext().then(apply)}
            >
              ↓ Next
            </button>
            <span className="setlist-preview-hint">Preview · row click or ↑↓ when not typing</span>
          </div>
        </div>
        <div className="setlist-header">
          <span />
          <span>PC</span>
          <span>Title</span>
          <span>Year</span>
          <span className="setlist-h-live">Live</span>
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
                  onChange={(patch) => updateRow(item.id, patch)}
                  onRemove={() => void window.viewer.removeSong(item.id).then(apply)}
                  onActivateRow={() => void window.viewer.selectSong(item.id).then(apply)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="setlist-footer">
          {state.setlist.length === 0 ? (
            <p className="setlist-hint">
              Row order = program numbers 1, 2, 3… Incoming MIDI PCs select the song (0→PC1, 1→PC2, …).
            </p>
          ) : (
            <p className="setlist-hint">
              Reorder with ⋮⋮ to change PCs. Year is a 4-digit release year shown on the ESP.
              Preview controls do not send MIDI to Cubase.
            </p>
          )}
          <button type="button" className="primary setlist-add-btn" onClick={() => void window.viewer.addSong().then(apply)}>
            + Add song
          </button>
        </div>
      </section>
    </div>
  )
}
