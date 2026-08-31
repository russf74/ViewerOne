import fs from 'node:fs'
import {
  cubasePsStop,
  cubaseRenderPrepare,
  isKeepableLengthForTitle,
  titlesFuzzyMatch,
  type CubaseLengthRead
} from './cubaseLengthCapture.js'
import { cubaseRenderPathForSong } from './cubaseRenderPaths.js'
import { decodeAudioFileToMonoPcm } from './audioDecode.js'
import { analyzeMonoPcm } from '../shared/audioAnalysis.js'
import { buildLightingProgram } from '../shared/lightingProgram.js'
import type { LightingAnalyzeScanState, LightingProgram, SetlistItem, SongAudioAnalysis } from '../shared/types.js'
import { LoopbackRecorder } from './loopbackRecord.js'
import { songLengthSeconds } from '../shared/setlistTiming.js'

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
  minimizeUi: () => Promise<void>
  restoreUi: () => Promise<void>
  loopbackDevice: string
}

const CAPTURE_PAD_MS = 600
const MIN_CAPTURE_SEC = 5

function isUsablePrep(read: CubaseLengthRead, title: string): boolean {
  return Boolean(
    read.ok &&
      read.nameMatched &&
      read.mmss &&
      isKeepableLengthForTitle(read.mmss, title)
  )
}

async function captureRenderedPlayback(
  deps: LightingAnalyzeDeps,
  outputPath: string,
  durationSec: number
): Promise<boolean> {
  const recorder = new LoopbackRecorder()
  const durationMs = Math.max(MIN_CAPTURE_SEC, durationSec) * 1000 + CAPTURE_PAD_MS
  try {
    recorder.start({
      outputPath,
      deviceName: deps.loopbackDevice,
      onError: (msg) => console.warn('[ViewerOne] Loopback record:', msg)
    })
    await deps.sleep(250)
    deps.sendAnalyzePlay()
    await deps.sleep(durationMs)
    deps.sendAnalyzeStop()
    await cubasePsStop()
    await deps.sleep(200)
    await recorder.stop()
    await deps.sleep(120)
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000
  } catch (err) {
    console.warn('[ViewerOne] Render capture failed:', err)
    await recorder.stop()
    deps.sendAnalyzeStop()
    await cubasePsStop()
    return false
  }
}

async function analyzeRenderFile(
  filePath: string
): Promise<{ audioAnalysis: SongAudioAnalysis; lightingProgram: LightingProgram } | null> {
  try {
    const { samples, sampleRate, durationMs } = await decodeAudioFileToMonoPcm(filePath)
    const audioAnalysis = analyzeMonoPcm(samples, sampleRate, durationMs)
    const lightingProgram = buildLightingProgram(audioAnalysis)
    return { audioAnalysis, lightingProgram }
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
    message: 'Rewinding Cubase arranger…'
  })

  try {
    await deps.rewindArranger()
    if (deps.isCancelled()) {
      deps.setScan({ active: false, phase: 'cancelled', message: 'Cancelled.' })
      return
    }

    const programs: number[] = []
    let currentProgram = deps.getLatestProgram()
    if (currentProgram == null) {
      deps.sendArrangerCommand('next')
      await deps.sleep(800)
      currentProgram = deps.getLatestProgram()
    }
    if (currentProgram == null) {
      deps.setScan({
        active: false,
        phase: 'error',
        message: 'No Cubase song PC detected — check MIDI connection.'
      })
      return
    }

    programs.push(currentProgram)
    let captured = 0

    const processSong = async (program: number, index: number): Promise<void> => {
      const row = setlist.find((r) => r.program === program)
      if (!row) return
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
          `[ViewerOne] Lighting analyze: skip PC ${program} “${title}” — Cubase name mismatch (${prep.infoName})`
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

      const renderPath = cubaseRenderPathForSong(program, title)
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
      const analyzed = await analyzeRenderFile(renderPath)
      if (!analyzed) return

      deps.updateRow(row.id, {
        audioSource: 'cubase-render',
        cubaseRenderPath: renderPath,
        cubaseRenderCapturedAt: new Date().toISOString(),
        backingTrackPath: undefined,
        audioAnalysis: analyzed.audioAnalysis,
        lightingProgram: analyzed.lightingProgram,
        length: prep.mmss || row.length
      })
      captured++
      deps.setScan({ collected: captured })
      console.log(
        `[ViewerOne] Lighting analyze: PC ${program} “${title}” → ${analyzed.audioAnalysis.bpm} BPM, ${analyzed.lightingProgram.cues.length} cues`
      )
    }

    deps.setScan({ phase: 'walking', message: `Capturing song 1…` })
    await processSong(currentProgram, 1)

    while (!deps.isCancelled()) {
      const before = currentProgram
      deps.sendArrangerCommand('next')
      const next = await deps.waitForProgramChange(before)
      if (next == null || next === before || programs.includes(next)) break
      programs.push(next)
      currentProgram = next
      await deps.restoreProgram(currentProgram)
      await processSong(currentProgram, programs.length)
    }

    await deps.rewindArranger()

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
