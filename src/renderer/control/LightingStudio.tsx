import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, PublicState, SetlistItem } from '../../shared/types'
import type { LightingProgram } from '../../shared/lightingProgram'
import { LED_PATTERNS, formatLedPatternLabel } from '../../shared/ledPatterns'
import { formatMsToTimecode, parseTimecodeToMs, resolveActiveCues } from '../../shared/lightingProgram'
import { resolveLoopbackDevice, sortAudioDevices } from '../../shared/dshowAudioDevices'
import {
  peakToMeterWidth,
  type LoopbackMeterSample
} from '../../shared/audioLevel'

type Props = {
  row: SetlistItem | null
  state: PublicState
  onSaveProgram: (program: LightingProgram) => void
  onPatchSettings: (patch: Partial<AppState>) => void
  onPatchClickTrack: (patch: Partial<AppState['clickTrack']>) => void
}

function songPlayheadMs(state: PublicState, row: SetlistItem): number {
  if (
    state.lightingDirector.active &&
    state.lightingDirector.songId === row.id &&
    state.lightingDirector.performanceMs > 0
  ) {
    return state.lightingDirector.performanceMs
  }
  const total = state.countdown.totalSeconds
  const rem = state.countdown.remainingSeconds
  if (total && rem != null) return Math.max(0, Math.round((total - rem) * 1000))
  return 0
}

export function LightingCueEditor({
  row,
  state,
  onSaveProgram
}: Pick<Props, 'row' | 'state' | 'onSaveProgram'>) {
  const [timeDrafts, setTimeDrafts] = useState<Record<string, string>>({})
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)

  const program = row?.lightingProgram
  const playheadMs = row ? songPlayheadMs(state, row) : 0
  const durationMs = Math.max(
    1,
    row?.audioAnalysis?.durationMs ??
      (program?.cues?.length ? program.cues[program.cues.length - 1].atMs + 1000 : 1)
  )
  const activeState = program ? resolveActiveCues(program, playheadMs) : null
  const nowCue = activeState ? (activeState.accent ?? activeState.base) : null
  const nowKey = nowCue ? (nowCue.id ?? String(nowCue.atMs)) : null

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [nowKey])

  if (!row || !program?.cues?.length) {
    return (
      <p className="settings-hint">
        Select a song with a lighting program to edit cues, or run Analyze from Cubase.
      </p>
    )
  }

  const updateCue = (idx: number, patch: Partial<(typeof program.cues)[0]>) => {
    const next: LightingProgram = {
      ...program,
      cues: program.cues.map((c, i) => (i === idx ? { ...c, ...patch } : c))
    }
    onSaveProgram(next)
  }

  const addCue = () => {
    const last = program.cues[program.cues.length - 1]
    const next: LightingProgram = {
      ...program,
      cues: [
        ...program.cues,
        {
          id: crypto.randomUUID(),
          atMs: (last?.atMs ?? 0) + 15000,
          ledPatternId: 8,
          label: 'manual',
          dmxLook: 'live'
        }
      ].sort((a, b) => a.atMs - b.atMs)
    }
    onSaveProgram(next)
  }

  const removeCue = (idx: number) => {
    if (program.cues.length <= 1) return
    onSaveProgram({
      ...program,
      cues: program.cues.filter((_, i) => i !== idx)
    })
  }

  const playPct = Math.min(100, (playheadMs / durationMs) * 100)
  const nowPattern = nowCue ? formatLedPatternLabel(nowCue.ledPatternId) : null

  return (
    <div className="lighting-cue-editor">
      {nowCue ? (
        <p className="cue-now-banner" role="status">
          Now {formatMsToTimecode(playheadMs)} · {nowCue.label ?? 'cue'} · {nowPattern}
        </p>
      ) : (
        <p className="settings-hint">Play the song to follow the live DMX cue.</p>
      )}
      <div className="cue-timeline" aria-hidden>
        {program.cues.map((cue) => (
          <span
            key={cue.id ?? cue.atMs}
            className={`cue-timeline-mark${(cue.id ?? String(cue.atMs)) === nowKey ? ' cue-timeline-mark--now' : ''}`}
            style={{ left: `${Math.min(100, (cue.atMs / durationMs) * 100)}%` }}
            title={`${cue.label ?? 'cue'} @ ${formatMsToTimecode(cue.atMs)}`}
          />
        ))}
        <span className="cue-timeline-playhead" style={{ left: `${playPct}%` }} />
      </div>
      <div className="cue-table-wrap">
        <table className="cue-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Section</th>
              <th>Pattern</th>
              <th>DMX</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {program.cues.map((cue, idx) => {
              const key = cue.id ?? String(cue.atMs)
              const timeVal = timeDrafts[key] ?? formatMsToTimecode(cue.atMs)
              const isNow = key === nowKey
              return (
                <tr key={key} ref={isNow ? activeRowRef : undefined} className={isNow ? 'cue-row--now' : undefined}>
                  <td>
                    <input
                      className="text-input cue-time-input"
                      value={timeVal}
                      onChange={(e) =>
                        setTimeDrafts((d) => ({ ...d, [key]: e.target.value }))
                      }
                      onBlur={() => {
                        const ms = parseTimecodeToMs(timeDrafts[key] ?? '')
                        if (ms != null) updateCue(idx, { atMs: ms })
                        setTimeDrafts((d) => {
                          const next = { ...d }
                          delete next[key]
                          return next
                        })
                      }}
                      aria-label="Cue time mm:ss"
                    />
                  </td>
                  <td>
                    <input
                      className="text-input"
                      value={cue.label ?? ''}
                      onChange={(e) => updateCue(idx, { label: e.target.value })}
                      aria-label="Section label"
                    />
                  </td>
                  <td>
                    <select
                      value={cue.ledPatternId}
                      onChange={(e) => updateCue(idx, { ledPatternId: Number(e.target.value) })}
                    >
                      {LED_PATTERNS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={cue.dmxLook ?? 'live'}
                      onChange={(e) =>
                        updateCue(idx, {
                          dmxLook: e.target.value as 'off' | 'idle' | 'live'
                        })
                      }
                      aria-label="DMX look"
                    >
                      <option value="live">Live</option>
                      <option value="idle">Idle</option>
                      <option value="off">Off</option>
                    </select>
                  </td>
                  <td>
                    <button type="button" className="track-btn" onClick={() => removeCue(idx)}>
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <button type="button" className="setlist-step-btn" onClick={addCue}>
        + Add cue
      </button>
    </div>
  )
}

function loopbackMeterLabel(sample: LoopbackMeterSample | null, hold: number): string {
  if (!sample) return 'meter off'
  if (sample.error) return "can't open"
  if (sample.paused) return 'paused (analyze recording)'
  if (!sample.listening) return 'opening device…'
  if (hold < 0.003) return 'no signal'
  const db = sample.peakDbfs <= -89 ? '-∞ dB' : `${sample.peakDbfs.toFixed(0)} dB`
  if (hold > 0.89) return `hot  ${db}`
  return db
}

function LoopbackSignalBar({
  device,
  onResolved
}: {
  device: string
  onResolved: (name: string) => void
}) {
  const [sample, setSample] = useState<LoopbackMeterSample | null>(null)
  const holdRef = useRef(0)
  const [hold, setHold] = useState(0)
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  useEffect(() => {
    if (!device.trim()) {
      void window.viewer.stopLoopbackMeter()
      setSample(null)
      holdRef.current = 0
      setHold(0)
      return
    }
    let cancelled = false
    void window.viewer.startLoopbackMeter(device).then((resolved) => {
      if (cancelled || !resolved) return
      if (resolved !== device) onResolvedRef.current(resolved)
    })
    const off = window.viewer.onLoopbackMeter((next) => {
      setSample(next)
      const p = next.paused || next.error ? 0 : next.peak
      if (p >= holdRef.current) holdRef.current = p
      else holdRef.current = Math.max(p, holdRef.current * 0.55)
      setHold(holdRef.current)
    })
    return () => {
      cancelled = true
      off()
      void window.viewer.stopLoopbackMeter()
    }
  }, [device])

  const width = peakToMeterWidth(hold)
  const tone = !sample || sample.error || sample.paused || hold < 0.003 ? '' : hold > 0.89 ? 'hot' : 'ok'

  return (
    <div
      className={`loopback-meter${tone ? ` loopback-meter--${tone}` : ''}${sample?.error ? ' loopback-meter--hot' : ''}`}
      role="meter"
      aria-label="Cubase loopback level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width * 100)}
    >
      <div className="loopback-meter-row">
        <div className="loopback-meter-track">
          <div className="loopback-meter-fill" style={{ width: `${width * 100}%` }} />
          <div className="loopback-meter-peak" style={{ left: `${width * 100}%` }} />
        </div>
        <span className="loopback-meter-db">{loopbackMeterLabel(sample, hold)}</span>
      </div>
      {sample?.error ? <p className="settings-hint settings-hint--warn">{sample.error}</p> : null}
    </div>
  )
}

export function LightingStudio({ row, state, onSaveProgram, onPatchSettings, onPatchClickTrack }: Props) {
  const readiness = state.lightingReadiness
  const ct = state.clickTrack
  const [devices, setDevices] = useState<string[]>([])
  const [listingDevices, setListingDevices] = useState(true)
  const autoMatched = useRef(false)

  const loadDevices = () => {
    setListingDevices(true)
    void window.viewer
      .listLoopbackDevices()
      .then((found) => {
        const list = Array.isArray(found) ? found.filter((n) => typeof n === 'string' && n.trim()) : []
        setDevices(list)
        if (!autoMatched.current) {
          const resolved = resolveLoopbackDevice(state.lightingLoopbackDevice, list)
          if (resolved && resolved !== state.lightingLoopbackDevice) {
            autoMatched.current = true
            onPatchSettings({ lightingLoopbackDevice: resolved })
          } else if (resolved) {
            autoMatched.current = true
          }
        }
      })
      .catch(() => setDevices([]))
      .finally(() => setListingDevices(false))
  }

  useEffect(() => {
    loadDevices()
    // Load once when Lighting Studio opens; Refresh re-lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deviceOptions = useMemo(() => {
    const current = state.lightingLoopbackDevice.trim()
    const extra = current && !devices.includes(current) ? [current] : []
    return sortAudioDevices([...devices, ...extra])
  }, [devices, state.lightingLoopbackDevice])

  const clickHint = useMemo(() => {
    if (!row?.clickTrackPath) return null
    const parts = row.clickTrackPath.split(/[/\\]/)
    return parts[parts.length - 1]
  }, [row?.clickTrackPath])

  return (
    <div className="lighting-studio">
      <h3 className="settings-subheading">Lighting Studio</h3>
      <p className="settings-hint">
        Sidecar only — Cubase playback and ViewerOne gig flow stay unchanged until you opt in.
        Analyze captures <strong>real Cubase output</strong> (tempo/key/cut/paste included).
      </p>

      <div className="lighting-readiness">
        <strong>
          Gig readiness: {readiness.readyCount}/{readiness.totalSongs} songs
        </strong>
        {!readiness.gigReady && readiness.totalSongs > 0 ? (
          <ul className="readiness-issues">
            {readiness.rows
              .filter((r) => !r.ready)
              .slice(0, 6)
              .map((r) => (
                <li key={r.id}>
                  PC {r.program} {r.title}: {r.issues.join('; ')}
                </li>
              ))}
          </ul>
        ) : readiness.gigReady ? (
          <p className="settings-hint lighting-director-live">All performance songs ready.</p>
        ) : null}
      </div>

      <label className="esp-enable">
        <input
          type="checkbox"
          checked={state.lightingDirectorEnabled}
          onChange={(e) => onPatchSettings({ lightingDirectorEnabled: e.target.checked })}
        />
        <span>Enable PC 127 timed lighting programs at the gig</span>
      </label>
      <label className="esp-enable">
        <input
          type="checkbox"
          checked={state.liveAudioSyncEnabled}
          onChange={(e) => onPatchSettings({ liveAudioSyncEnabled: e.target.checked })}
        />
        <span>Live audio beat sync (loopback nudge during show)</span>
      </label>

      <div className="lighting-studio-grid">
        <div className="field">
          <label htmlFor="loopback-device">Recording device Cubase is heard through</label>
          <div className="loopback-device-row">
            <select
              id="loopback-device"
              value={state.lightingLoopbackDevice}
              disabled={listingDevices && devices.length === 0}
              onChange={(e) => onPatchSettings({ lightingLoopbackDevice: e.target.value })}
            >
              {listingDevices && devices.length === 0 ? (
                <option value={state.lightingLoopbackDevice}>Looking for devices…</option>
              ) : deviceOptions.length === 0 ? (
                <option value="">No recording devices found</option>
              ) : (
                deviceOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="track-btn"
              onClick={() => {
                autoMatched.current = false
                loadDevices()
              }}
              disabled={listingDevices}
            >
              Refresh
            </button>
          </div>
          <p className="settings-hint">
            Pick Stereo Mix (or your interface loopback). The list is enabled Windows recording devices.
            Play Cubase — the bar is what Analyze will record. Stereo Mix follows PC volume; a virtual
            cable (VB-Cable / Voicemeeter) does not.
          </p>
        </div>
        <div className="field">
          <label htmlFor="capture-mode">Cubase capture mode</label>
          <select
            id="capture-mode"
            value={state.lightingCaptureMode}
            onChange={(e) =>
              onPatchSettings({
                lightingCaptureMode: e.target.value as 'playback' | 'export'
              })
            }
          >
            <option value="playback">Playback + loopback record (recommended)</option>
            <option value="export">Export folder watch (advanced)</option>
          </select>
        </div>
      </div>
      {listingDevices && devices.length === 0 ? (
        <p className="settings-hint">Looking for recording devices…</p>
      ) : (
        <LoopbackSignalBar
          device={state.lightingLoopbackDevice}
          onResolved={(name) => {
            if (name !== state.lightingLoopbackDevice) {
              onPatchSettings({ lightingLoopbackDevice: name })
            }
          }}
        />
      )}

      <h4 className="settings-subheading">IEM click track</h4>
      <p className="settings-hint">
        Generates a 48 kHz WAV: <strong>4 count-in beeps</strong>, then song clicks. In Cubase,
        slip the clip so those four beeps sit before the audio — first click after the beeps is
        beat 1.
      </p>
      <label className="esp-enable">
        <input
          type="checkbox"
          checked={ct.generateWav}
          onChange={(e) => onPatchClickTrack({ generateWav: e.target.checked })}
        />
        <span>Auto-generate click WAV when analyzing</span>
      </label>
      <label className="esp-enable">
        <input
          type="checkbox"
          checked={ct.liveMidiEnabled}
          onChange={(e) => onPatchClickTrack({ liveMidiEnabled: e.target.checked })}
        />
        <span>Live MIDI click during transport (IEM)</span>
      </label>
      <div className="lighting-studio-grid">
        <div className="field">
          <label htmlFor="click-ch">MIDI channel</label>
          <input
            id="click-ch"
            className="text-input"
            type="number"
            min={1}
            max={16}
            value={ct.midiChannel}
            onChange={(e) => onPatchClickTrack({ midiChannel: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="click-note">Beat note</label>
          <input
            id="click-note"
            className="text-input"
            type="number"
            min={0}
            max={127}
            value={ct.midiNote}
            onChange={(e) => onPatchClickTrack({ midiNote: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="accent-note">Downbeat note</label>
          <input
            id="accent-note"
            className="text-input"
            type="number"
            min={0}
            max={127}
            value={ct.accentNote}
            onChange={(e) => onPatchClickTrack({ accentNote: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="count-in">Count-in bars</label>
          <input
            id="count-in"
            className="text-input"
            type="number"
            min={0}
            max={4}
            value={ct.countInBars}
            onChange={(e) => onPatchClickTrack({ countInBars: Number(e.target.value) })}
          />
        </div>
      </div>
      {row?.audioAnalysis ? (
        <p className="settings-hint">
          Current song: {row.audioAnalysis.bpm} BPM
          {row.clickTrackCountInMs
            ? ` · count-in ${Math.round(row.clickTrackCountInMs / 1000)}s (live MIDI)`
            : ' · click WAV matches song length'}
          {clickHint ? ` · click file ${clickHint}` : ''}
        </p>
      ) : null}
      {state.clickTrackLive.enabled && state.transport.playing ? (
        <p className="settings-hint lighting-director-live">
          Live click active · beat {state.clickTrackLive.lastBeatIndex ?? '—'}
          {state.clickTrackLive.nextBeatMs != null
            ? ` · next @ ${formatMsToTimecode(state.clickTrackLive.nextBeatMs)}`
            : ''}
        </p>
      ) : null}

      {state.lightingDirector.active ? (
        <p className="settings-hint lighting-director-live">
          Director: {state.lightingDirector.activeCueLabel ?? '—'} · pattern{' '}
          {state.lightingDirector.activePatternId ?? '—'} ·{' '}
          {Math.round(state.lightingDirector.performanceMs / 1000)}s
        </p>
      ) : null}

      {state.lightingAnalyze.active ? (
        <p className="settings-hint">Cubase analyze: {state.lightingAnalyze.message}</p>
      ) : null}

      <h4 className="settings-subheading">Cue program — {row?.title ?? 'no song selected'}</h4>
      <LightingCueEditor row={row} state={state} onSaveProgram={onSaveProgram} />
    </div>
  )
}
