import fs from 'node:fs'
import {
  cubasePsStop,
  cubasePsPlay,
  cubaseRenderPrepare,
  isKeepableLengthForTitle,
  prepareCubaseWindowForCapture,
  titlesFuzzyMatch,
  type CubaseLengthRead
} from './cubaseLengthCapture.js'
import { cubaseRenderPathForSong } from './cubaseRenderPaths.js'
import type { ClickTrackSettings, LightingAnalyzeScanState, SetlistItem } from '../shared/types.js'
import type { SongAudioAnalysis } from '../shared/audioAnalysis.js'
import type { LightingProgram } from '../shared/lightingProgram.js'
import { LoopbackRecorder } from './loopbackRecord.js'
import { songLengthSeconds } from '../shared/setlistTiming.js'
import type { LightingDirector } from './lightingDirector.js'

export type LightingAnalyzeDeps = {
  getSetlist: () => SetlistItem[]
  updateRow: (songId: string, patch: Partial<SetlistItem>) => void
  setScan: (patch: Partial<LightingAnalyzeScanState>) => void
  isCancelled: () => boolean
  sleep: (ms: number) => Promise<void>
  /** MIDI Previous/Next — same as arranger scan walk. */
  sendArrangerCommand: (dir: 'prev' | 'next') => void
  rewindArranger: () => Promise<void>
  waitForProgramChange: (fromProgram: number) => Promise<number | null>
  getLatestProgram: () => number | null
  restoreProgram: (program: number) => Promise<void>
  /** Isolated Cubase play/stop — must NOT update gig countdown/transport. */
  sendAnalyzePlay: () => void
  sendAnalyzeStop: () => void
  /** Unmute Cubase ALL/FX for the capture window; restore afterwards. */
  withLiveMix: <T>(fn: () => Promise<T>) => Promise<T>
  minimizeUi: () => Promise<void>
  restoreUi: () => Promise<void>
  loopbackDevice: string
  clickSettings: ClickTrackSettings
  director: LightingDirector
  /** Stop after this many successful captures (CLI `--lighting-analyze-max=N`). */
  maxCaptures?: number
}

const CAPTURE_PAD_MS = 600
const MIN_CAPTURE_SEC = 5

function shouldCaptureSong(row: SetlistItem): boolean {
  const t = row.title.toUpperCase()
  if (t.includes('SOUNDCHECK')) return false
  if (t.startsWith('INTRO') || t.startsWith('OUTRO')) return false
  return row.program >= 1 && row.program <= 119
}

function isUsablePrep(read: CubaseLengthRead, title: string): boolean {
  return Boolean(
    read.ok &&
      read.nameMatched &&
      read.mmss &&
      isKeepableLengthForTitle(read.mmss, title)
  )
}

function wavFilePeak(filePath: string): number {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0
    let offset = 12
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4)
      const size = buf.readUInt32LE(offset + 4)
      const dataStart = offset + 8
      if (id === 'data') {
        const end = Math.min(buf.length, dataStart + size)
        let peak = 0
        for (let i = dataStart; i + 1 < end; i += 2) {
          const s = Math.abs(buf.readInt16LE(i))
          if (s > peak) peak = s
        }
        return peak / 32768
      }
      offset = dataStart + size + (size % 2)
    }
    return 0
  } catch {
    return 0
  }
}

async function captureRenderedPlayback(
  deps: LightingAnalyzeDeps,
  outputPath: string,
  durationSec: number
): Promise<boolean> {
  const recorder = new LoopbackRecorder()
  const durationMs = Math.max(MIN_CAPTURE_SEC, durationSec) * 1000 + CAPTURE_PAD_MS
  try {
    return await deps.withLiveMix(async () => {
      recorder.start({
        outputPath,
        deviceName: deps.loopbackDevice,
        durationSec: durationMs / 1000,
        onError: (msg) => console.warn('[ViewerOne] Loopback record:', msg)
      })
      await deps.sleep(250)
      deps.sendAnalyzePlay()
      await cubasePsPlay()
      await deps.sleep(durationMs + 800)
      deps.sendAnalyzeStop()
      await cubasePsStop()
      await deps.sleep(200)
      await recorder.stop()
      await deps.sleep(120)
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 1000) return false
      const peak = wavFilePeak(outputPath)
      console.log(`[ViewerOne] Lighting analyze: capture peak ${peak.toFixed(4)} (${outputPath})`)
      if (peak < 0.004) {
        console.warn('[ViewerOne] Lighting analyze: capture was silence — Cubase ALL/FX mute or Stereo Mix not hearing playback')
        return false
      }
      return true
    })
  } catch (err) {
    console.warn('[ViewerOne] Render capture failed:', err)
    await recorder.stop()
    deps.sendAnalyzeStop()
    await cubasePsStop()
    return false
  }
}

async function analyzeRenderFile(
  deps: LightingAnalyzeDeps,
  song: SetlistItem,
  filePath: string
): Promise<{
  audioAnalysis: SongAudioAnalysis
  lightingProgram: LightingProgram
  clickTrackPath?: string
  clickTrackCountInMs?: number
} | null> {
  try {
    return await deps.director.analyzeFromRenderWav(song, filePath, deps.clickSettings)
  } catch (err) {
    console.warn('[ViewerOne] Render analyze failed:', err)
    return null
  }
}

/**
 * Walk Cubase arranger and capture REAL rendered audio per song (loopback during playback).
 * Sidecar-only — never runs automatically; does not modify arranger scan or gig countdown.
 */
export async function runLightingAnalyzePass(deps: LightingAnalyzeDeps): Promise<void> {
  const setlist = deps.getSetlist().filter((r) => r.program >= 1 && r.program <= 119)
  if (setlist.length === 0) {
    deps.setScan({
      active: false,
      phase: 'error',
      message: 'Setlist is empty — scan arranger or add songs first.'
    })
    return
  }

  deps.setScan({
    active: true,
    phase: 'preparing',
    collected: 0,
    total: setlist.length,
    message: 'Preparing Cubase for render capture…'
  })

  try {
    await prepareCubaseWindowForCapture()
    if (deps.isCancelled()) {
      deps.setScan({ active: false, phase: 'cancelled', message: 'Cancelled.' })
      return
    }

    const targets = setlist
      .filter((r) => shouldCaptureSong(r) && r.arrangerIndex != null)
      .sort((a, b) => (a.arrangerIndex ?? 0) - (b.arrangerIndex ?? 0))
    const limit = deps.maxCaptures && deps.maxCaptures > 0 ? deps.maxCaptures : targets.length
    const planned = targets.slice(0, limit)
    deps.setScan({ total: planned.length })

    let captured = 0

    const processSong = async (row: SetlistItem, index: number): Promise<void> => {
      const title = row.title.trim()
      if (!title) return

      deps.setScan({
        phase: 'capturing',
        collected: captured,
        message: `Song ${index}: “${title}” — selecting in Cubase…`
      })

      await deps.minimizeUi()
      let prep: CubaseLengthRead
      try {
        prep = await cubaseRenderPrepare(title)
      } finally {
        await deps.restoreUi()
      }

      if (deps.isCancelled()) return

      if (!isUsablePrep(prep, title) && prep.infoName && !titlesFuzzyMatch(title, prep.infoName)) {
        console.warn(
          `[ViewerOne] Lighting analyze: skip PC ${row.program} “${title}” — Cubase name mismatch (${prep.infoName})`
        )
        return
      }

      const durationSec = prep.mmss
        ? songLengthSeconds(prep.mmss)
        : row.length
          ? songLengthSeconds(row.length)
          : 0
      if (durationSec < MIN_CAPTURE_SEC) {
        console.warn(`[ViewerOne] Lighting analyze: skip “${title}” — length too short (${durationSec}s)`)
        return
      }

      const renderPath = cubaseRenderPathForSong(row.program, title)
      deps.setScan({
        message: `Song ${index}: “${title}” — recording Cubase output (${prep.mmss || row.length})…`
      })

      await deps.minimizeUi()
      let ok = false
      try {
        ok = await captureRenderedPlayback(deps, renderPath, durationSec)
      } finally {
        await deps.restoreUi()
      }

      if (deps.isCancelled()) return
      if (!ok) {
        console.warn(`[ViewerOne] Lighting analyze: capture failed for “${title}”`)
        return
      }

      deps.setScan({ phase: 'analyzing', message: `Song ${index}: “${title}” — analyzing render…` })
      const analyzed = await analyzeRenderFile(deps, row, renderPath)
      if (!analyzed) return

      deps.updateRow(row.id, {
        audioSource: 'cubase-render',
        cubaseRenderPath: renderPath,
        cubaseRenderCapturedAt: new Date().toISOString(),
        backingTrackPath: undefined,
        audioAnalysis: analyzed.audioAnalysis,
        lightingProgram: analyzed.lightingProgram,
        clickTrackPath: analyzed.clickTrackPath,
        clickTrackCountInMs: analyzed.clickTrackCountInMs,
        length: prep.mmss || row.length
      })
      captured++
      deps.setScan({ collected: captured })
      console.log(
        `[ViewerOne] Lighting analyze: PC ${row.program} “${title}” → ${analyzed.audioAnalysis.bpm} BPM, ${analyzed.lightingProgram.cues.length} cues`
      )
    }

    for (let i = 0; i < planned.length && !deps.isCancelled(); i++) {
      await processSong(planned[i], i + 1)
    }

    deps.setScan({
      active: false,
      phase: 'complete',
      collected: captured,
      message:
        captured > 0
          ? `Done — ${captured} song(s) analyzed from Cubase renders.`
          : 'Finished — no songs captured (check Stereo Mix + Cubase output).'
    })
  } catch (err) {
    deps.setScan({
      active: false,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}
