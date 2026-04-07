import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { DisplayPreview } from './DisplayPreview'

export function App() {
  const [state, setState] = useState<PublicState | null>(null)
  const bridgeOk = typeof window !== 'undefined' && typeof window.viewer !== 'undefined'

  useEffect(() => {
    if (!bridgeOk) return
    let off: (() => void) | undefined
    void window.viewer.getState().then(setState)
    off = window.viewer.onState(setState)
    return () => off?.()
  }, [bridgeOk])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 }
    })
  )

  const apply = useCallback((next: PublicState) => {
    setState(next)
  }, [])

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
      <div className="control-root">
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
    return <div className="control-root">Loading…</div>
  }

  return (
    <div className="control-root">
      <header className="app-header">
        <div>
          <h1 className="app-title">
            ViewerOne
            <span className="version-badge" title="App version — bump package.json and rebuild to update">
              v{state.appVersion}
            </span>
          </h1>
          <p className="sub">Cubase setlist + touch display · settings auto-saved</p>
        </div>
        <div className="header-actions">
          <button type="button" className="primary" onClick={() => void window.viewer.openDisplay().then(apply)}>
            Open 2nd screen
          </button>
          <button type="button" onClick={() => void window.viewer.hideDisplay().then(apply)}>
            Hide display
          </button>
        </div>
      </header>

      <section className="panel panel-display-preview">
        <h2>Touch display preview</h2>
        <DisplayPreview state={state} apply={apply} />
      </section>

      <section className="panel">
        <h2>MIDI &amp; transport</h2>
        <div className="setup-cols">
          <div>
            <p className="setup-block-title">Ports</p>
            <div className="row-flex">
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label htmlFor="in">In (Cubase → app)</label>
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
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label htmlFor="out">Out (app → Cubase)</label>
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
              <div className="field" style={{ width: '64px' }}>
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
              <button type="button" onClick={() => void window.viewer.refreshMidi().then(apply)}>
                Refresh
              </button>
            </div>
          </div>

          <div>
            <p className="setup-block-title">Touch row (Start / Stop / mutes)</p>
            <div className="row-flex">
              <div className="field" style={{ flex: '1 1 100px' }}>
                <label>Transport</label>
                <select
                  value={state.transport.mode}
                  onChange={(e) =>
                    void patchSettings({
                      transport: { ...state.transport, mode: e.target.value === 'mmc' ? 'mmc' : 'note' }
                    })
                  }
                >
                  <option value="note">Note → MIDI Remote</option>
                  <option value="mmc">MMC SysEx</option>
                </select>
              </div>
              <div className="field" style={{ width: '52px' }}>
                <label>Ch</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={state.transport.channel}
                  onChange={(e) =>
                    void patchSettings({
                      transport: { ...state.transport, channel: Number(e.target.value) }
                    })
                  }
                />
              </div>
              <div className="field" style={{ width: '56px' }}>
                <label>Start</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.transport.startNote}
                  onChange={(e) =>
                    void patchSettings({
                      transport: { ...state.transport, startNote: Number(e.target.value) }
                    })
                  }
                />
              </div>
              <div className="field" style={{ width: '56px' }}>
                <label>Stop</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.transport.stopNote}
                  onChange={(e) =>
                    void patchSettings({
                      transport: { ...state.transport, stopNote: Number(e.target.value) }
                    })
                  }
                />
              </div>
            </div>
            <div className="row-flex" style={{ marginTop: 6 }}>
              <div className="field" style={{ width: '52px' }}>
                <label>All CC</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.muteAll.cc}
                  onChange={(e) =>
                    void patchSettings({
                      muteAll: { ...state.muteAll, cc: Number(e.target.value) }
                    })
                  }
                />
              </div>
              <div className="field" style={{ width: '44px' }}>
                <label>Ch</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={state.muteAll.channel}
                  onChange={(e) =>
                    void patchSettings({
                      muteAll: { ...state.muteAll, channel: Number(e.target.value) }
                    })
                  }
                />
              </div>
              <div className="field" style={{ width: '52px' }}>
                <label>FX CC</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.muteFx.cc}
                  onChange={(e) =>
                    void patchSettings({
                      muteFx: { ...state.muteFx, cc: Number(e.target.value) }
                    })
                  }
                />
              </div>
              <div className="field" style={{ width: '44px' }}>
                <label>Ch</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={state.muteFx.channel}
                  onChange={(e) =>
                    void patchSettings({
                      muteFx: { ...state.muteFx, channel: Number(e.target.value) }
                    })
                  }
                />
              </div>
            </div>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <div className="field" style={{ width: '72px' }}>
                <label>Muted val</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.muteAll.valueOn}
                  onChange={(e) => {
                    const valueOn = Number(e.target.value)
                    void patchSettings({
                      muteAll: { ...state.muteAll, valueOn },
                      muteFx: { ...state.muteFx, valueOn }
                    })
                  }}
                />
              </div>
              <div className="field" style={{ width: '72px' }}>
                <label>Unmuted val</label>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={state.muteAll.valueOff}
                  onChange={(e) => {
                    const valueOff = Number(e.target.value)
                    void patchSettings({
                      muteAll: { ...state.muteAll, valueOff },
                      muteFx: { ...state.muteFx, valueOff }
                    })
                  }}
                />
              </div>
            </div>
            <div className="field" style={{ marginTop: 8, maxWidth: 'min(100%, 320px)' }}>
              <label htmlFor="mute-out-mode">Mute CC send</label>
              <select
                id="mute-out-mode"
                value={state.muteAll.outMode ?? 'absolute'}
                onChange={(e) => {
                  const outMode = e.target.value === 'absolute' ? 'absolute' : 'toggle127'
                  void patchSettings({
                    muteAll: { ...state.muteAll, outMode },
                    muteFx: { ...state.muteFx, outMode }
                  })
                }}
              >
                <option value="absolute">Absolute (mute = value On, unmute = Off)</option>
                <option value="toggle127">Legacy: 127 pulse / toggle</option>
              </select>
            </div>
          </div>
        </div>

        <details className="details-hint">
          <summary>MIDI routing tips (loopMIDI, Cubase, X32)</summary>
          <p>
            Use a virtual cable (e.g. loopMIDI). Cubase → app <strong>input</strong> for program changes on the PC
            channel you set. App <strong>output</strong> → Cubase; use a MIDI track (see Transport hint) to forward CC
            to your X32 MIDI port.
          </p>
        </details>
        <details className="details-hint">
          <summary>Transport &amp; mute buttons</summary>
          <p>
            <strong>Note</strong> mode: map Start/Stop in <strong>MIDI Remote</strong>. <strong>MMC</strong>: SysEx
            play/stop. <strong>Mutes</strong> (defaults): CC <strong>0</strong> when muted, <strong>127</strong> when
            unmuted on Mic CC 80 / FX CC 85. Pass-through: MIDI track input = app loopback port, output = X32,
            monitoring on. Use <strong>absolute</strong>; swap value On/Off in settings only if your desk is inverted.
          </p>
        </details>
      </section>

      <section className="panel">
        <div className="setlist-toolbar">
          <h2>Setlist</h2>
        </div>
        <div className="setlist-header">
          <span />
          <span>PC</span>
          <span>Title</span>
          <span>Chords</span>
          <span className="setlist-h-live">Live</span>
          <span />
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
          <SortableContext items={state.setlist.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            {state.setlist.map((item) => (
              <SortableRow
                key={item.id}
                item={item}
                isCurrent={item.id === state.currentSongId}
                onChange={(patch) => updateRow(item.id, patch)}
                onRemove={() => void window.viewer.removeSong(item.id).then(apply)}
              />
            ))}
          </SortableContext>
        </DndContext>
        <div className="setlist-footer">
          {state.setlist.length === 0 ? (
            <p className="setlist-hint">
              PC column matches Cubase program numbers (1, 2, 3…). Incoming MIDI PCs are mapped 0→1, 1→2, etc.
            </p>
          ) : (
            <p className="setlist-hint">PC updates when you reorder. Cubase program N matches PC N here.</p>
          )}
          <button type="button" className="primary setlist-add-btn" onClick={() => void window.viewer.addSong().then(apply)}>
            + Add song
          </button>
        </div>
      </section>
    </div>
  )
}
