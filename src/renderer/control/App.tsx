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

export function App() {
  const [state, setState] = useState<PublicState | null>(null)
  const [espPorts, setEspPorts] = useState<{ path: string; friendly?: string }[]>([])
  const bridgeOk = typeof window !== 'undefined' && typeof window.viewer !== 'undefined'

  const refreshEspPorts = useCallback(() => {
    void window.viewer.listEsp32Ports().then(setEspPorts)
  }, [])

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
    refreshEspPorts()
    return () => off?.()
  }, [bridgeOk, refreshEspPorts])

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
    (id: string, patch: Pick<SetlistItem, 'title' | 'chords' | 'live'>) => {
      if (!state) return
      const nextItems = state.setlist.map((r) => (r.id === id ? { ...r, ...patch } : r))
      void setSetlist(nextItems)
    },
    [state, setSetlist]
  )

  const inputOptions = useMemo(() => {
    const ins = state?.inputs ?? []
    const outs = state?.outputs ?? []
    return { ins, outs }
  }, [state?.inputs, state?.outputs])

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
            <h1 className="app-title">
              ViewerOne
              <span className="version-badge" title="App version">
                v{state.appVersion}
              </span>
            </h1>
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
                Route a virtual cable (e.g. loopMIDI) from Cubase into <strong>In</strong> and back on <strong>Out</strong>.
                Program changes on <strong>PC ch</strong> pick the song. Send <strong>CC</strong> (default 85; muted = 0, unmuted = 127) on{' '}
                <strong>Mute ch</strong> to sync FX mute with the display; a tap on the ESP screen sends the same CC out.
              </p>
              <div className="settings-fields settings-fields--midi">
                <div className="field field-grow">
                  <label htmlFor="in">In (from Cubase)</label>
                  <select
                    id="in"
                    value={state.midiInputName ?? ''}
                    onChange={(e) => void patchSettings({ midiInputName: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {inputOptions.ins.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field field-grow">
                  <label htmlFor="out">Out (to Cubase)</label>
                  <select
                    id="out"
                    value={state.midiOutputName ?? ''}
                    onChange={(e) => void patchSettings({ midiOutputName: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {inputOptions.outs.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field field-pc">
                  <label htmlFor="pch">PC ch</label>
                  <input
                    id="pch"
                    type="number"
                    min={1}
                    max={16}
                    value={state.programChangeChannel}
                    onChange={(e) => void patchSettings({ programChangeChannel: Number(e.target.value) })}
                  />
                </div>
                <div className="field field-pc">
                  <label htmlFor="mch">Mute ch</label>
                  <input
                    id="mch"
                    type="number"
                    min={1}
                    max={16}
                    value={state.muteFxMidiChannel}
                    onChange={(e) => void patchSettings({ muteFxMidiChannel: Number(e.target.value) })}
                  />
                </div>
                <div className="field field-pc">
                  <label htmlFor="mcc">CC</label>
                  <input
                    id="mcc"
                    type="number"
                    min={0}
                    max={127}
                    value={state.muteFxCC}
                    onChange={(e) => void patchSettings({ muteFxCC: Number(e.target.value) })}
                  />
                </div>
                <label className="esp-enable esp-enable--inline">
                  <input
                    type="checkbox"
                    checked={state.fxMuted}
                    onChange={(e) => void patchSettings({ fxMuted: e.target.checked })}
                  />
                  <span>FX muted (tint + CC 0)</span>
                </label>
                <div className="field field-btn">
                  <label className="label-spacer" aria-hidden>
                    &nbsp;
                  </label>
                  <button type="button" className="btn-secondary" onClick={() => void window.viewer.refreshMidi().then(apply)}>
                    Refresh ports
                  </button>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <h2 className="settings-card-title">ESP32 display</h2>
              <p className="settings-card-lead">
                JSON lines at <strong>115200</strong> baud — same as the preview. Flash <code>firmware/esp32-display</code>{' '}
                for your board.
              </p>
              <div className="settings-fields settings-fields--esp">
                <label className="esp-enable">
                  <input
                    type="checkbox"
                    checked={state.esp32Enabled}
                    onChange={(e) => void patchSettings({ esp32Enabled: e.target.checked })}
                  />
                  <span>Enable USB serial</span>
                </label>
                <div className="field field-grow">
                  <label htmlFor="esp32-com">COM port</label>
                  <select
                    id="esp32-com"
                    value={state.esp32SerialPort ?? ''}
                    onChange={(e) => void patchSettings({ esp32SerialPort: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {espPorts.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.friendly ? `${p.path} — ${p.friendly}` : p.path}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field field-btn">
                  <label className="label-spacer" aria-hidden>
                    &nbsp;
                  </label>
                  <button type="button" className="btn-secondary" onClick={() => refreshEspPorts()}>
                    Refresh list
                  </button>
                </div>
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
          <span>Chords</span>
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
              Reorder with ⋮⋮ to change PCs. In Chords, type <strong>N</strong> for a line break on the ESP (the letter is not shown).
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
