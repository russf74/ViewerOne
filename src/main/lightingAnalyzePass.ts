import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { clickTrackPathForSong } from './clickTrackPaths.js'
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
  /** Capture only this setlist title (CLI `--lighting-analyze-title=`). */
  onlyTitle?: string
  /** Capture only this program change (CLI `--lighting-analyze-program=`). */
  onlyProgram?: number
}

const CAPTURE_PAD_MS = 600
const MIN_CAPTURE_SEC = 5
const CAPTURE_ATTEMPTS = 2

function analyzeLogPath(): string {
  return path.join(process.env.APPDATA ?? os.homedir(), 'viewer-one', 'lighting-analyze.log')
}

function analyzeLog(line: string): void {
  const msg = `[ViewerOne] Lighting analyze: ${line}`
  console.log(msg)
  try {
    fs.mkdirSync(path.dirname(analyzeLogPath()), { recursive: true })
    fs.appendFileSync(analyzeLogPath(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}

function clickFileExists(row: SetlistItem): boolean {
  const candidates = [row.clickTrackPath, clickTrackPathForSong(row.program, row.title)].filter(
    (p): p is string => Boolean(p)
  )
  return candidates.some((p) => fs.existsSync(p) && fs.statSync(p).size > 8000)
}

function listedDurationSec(row: SetlistItem): number {
  return row.length ? songLengthSeconds(row.length) : 0
}

function analysisDurationPlausible(row: SetlistItem): boolean {
  const listed = listedDurationSec(row)
  const analyzed = row.audioAnalysis?.durationMs ? row.audioAnalysis.durationMs / 1000 : 0
  if (listed < MIN_CAPTURE_SEC || analyzed <= 0) return true
  return analyzed <= listed * 1.25 + 2
}

function captureDurationSec(prepMmss: string, row: SetlistItem): number {
  const prep = prepMmss ? songLengthSeconds(prepMmss) : 0
  const listed = listedDurationSec(row)
  if (listed >= MIN_CAPTURE_SEC && prep > listed * 1.2) {
    analyzeLog(`cap duration ${prep}s → ${listed}s (setlist ${row.length})`)
    return listed
  }
  return prep >= MIN_CAPTURE_SEC ? prep : listed
}

function songAlreadyReady(row: SetlistItem): boolean {
  return Boolean(
    row.lightingProgram?.cues?.length &&
      row.audioAnalysis?.bpm &&
      clickFileExists(row) &&
      analysisDurationPlausible(row)
  )
}

function wavHeader(filePath: string): { sampleRate: number; durationSec: number } {
  try {
    const buf = fs.readFileSync(filePath, { encoding: null }).subarray(0, 44)
    if (buf.length < 32) return { sampleRate: 0, durationSec: 0 }
    const sampleRate = buf.readUInt32LE(24)
    const byteRate = buf.readUInt32LE(28)
    const size = fs.statSync(filePath).size
    if (byteRate <= 0) return { sampleRate, durationSec: 0 }
    return { sampleRate, durationSec: Math.max(0, (size - 44) / byteRate) }
  } catch {
    return { sampleRate: 0, durationSec: 0 }
  }
}

function wavDurationSec(filePath: string): number {
  return wavHeader(filePath).durationSec
}

function existingUsableRender(row: SetlistItem): string | null {
  const candidates = [row.cubaseRenderPath, cubaseRenderPathForSong(row.program, row.title)].filter(
    (p): p is string => Boolean(p)
  )
  const listed = listedDurationSec(row)
  for (const p of candidates) {
    if (!fs.existsSync(p) || fs.statSync(p).size <= 10_000 || wavFilePeak(p) < 0.004) continue
    const dur = wavDurationSec(p)
    if (listed >= MIN_CAPTURE_SEC && dur > listed * 1.25 + 2) {
      analyzeLog(`ignore overlong render ${p} (${dur.toFixed(1)}s vs setlist ${listed}s)`)
      continue
    }
    return p
  }
  return null
}

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
        sampleRate: 48000,
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
      const hdr = wavHeader(outputPath)
      analyzeLog(
        `capture peak ${peak.toFixed(4)} ${hdr.sampleRate}Hz ${hdr.durationSec.toFixed(3)}s (${outputPath})`
      )
      if (peak < 0.004) {
        analyzeLog('capture was silence — Cubase ALL/FX mute or Stereo Mix not hearing playback')
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

    let targets = setlist
      .filter((r) => shouldCaptureSong(r) && r.arrangerIndex != null)
      .sort((a, b) => (a.arrangerIndex ?? 0) - (b.arrangerIndex ?? 0))
    const onlyTitle = deps.onlyTitle?.trim()
    const onlyProgram =
      deps.onlyProgram && deps.onlyProgram > 0 ? Math.round(deps.onlyProgram) : undefined
    if (onlyProgram) {
      targets = targets.filter((r) => r.program === onlyProgram)
    }
    if (onlyTitle) {
      const want = onlyTitle.toLowerCase().replace(/[^a-z0-9]+/g, '')
      targets = targets.filter((r) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, '') === want)
    }
    if ((onlyTitle || onlyProgram) && targets.length === 0) {
      const msg = `No setlist song matches ${onlyProgram ? `PC ${onlyProgram}` : ''} ${onlyTitle ? `“${onlyTitle}”` : ''}`.trim()
      analyzeLog(msg)
      deps.setScan({ active: false, phase: 'error', message: msg })
      return
    }
    const limit = deps.maxCaptures && deps.maxCaptures > 0 ? deps.maxCaptures : targets.length
    const planned = targets.slice(0, limit)
    deps.setScan({ total: planned.length })
    analyzeLog(
      `start ${planned.length} song(s)` +
        planned.map((r) => ` PC${r.program} ${r.title}`).join(';')
    )

    let captured = 0

    const persistAnalysis = (
      row: SetlistItem,
      renderPath: string,
      analyzed: NonNullable<Awaited<ReturnType<typeof analyzeRenderFile>>>,
      length: string
    ): void => {
      deps.updateRow(row.id, {
        audioSource: 'cubase-render',
        cubaseRenderPath: renderPath,
        cubaseRenderCapturedAt: new Date().toISOString(),
        backingTrackPath: undefined,
        audioAnalysis: analyzed.audioAnalysis,
        lightingProgram: analyzed.lightingProgram,
        clickTrackPath: analyzed.clickTrackPath,
        clickTrackCountInMs: analyzed.clickTrackCountInMs,
        length: length || row.length
      })
      captured++
      deps.setScan({ collected: captured })
      analyzeLog(
        `OK PC ${row.program} “${row.title}” → ${analyzed.audioAnalysis.bpm} BPM, ${analyzed.lightingProgram.cues.length} cues, click=${analyzed.clickTrackPath ?? 'none'}`
      )
    }

    const processSong = async (row: SetlistItem, index: number): Promise<void> => {
      const title = row.title.trim()
      if (!title) return

      const recapture = Boolean(onlyTitle || onlyProgram)
      if (!recapture && songAlreadyReady(row)) {
        analyzeLog(`skip ready PC ${row.program} “${title}”`)
        captured++
        deps.setScan({ collected: captured, message: `Song ${index}: “${title}” — already ready.` })
        return
      }

      const reused = recapture ? null : existingUsableRender(row)
      if (reused) {
        deps.setScan({
          phase: 'analyzing',
          collected: captured,
          message: `Song ${index}: “${title}” — analyzing existing render…`
        })
        analyzeLog(`reuse render PC ${row.program} “${title}” (${reused})`)
        const analyzedReuse = await analyzeRenderFile(deps, row, reused)
        if (analyzedReuse) {
          persistAnalysis(row, reused, analyzedReuse, row.length)
          return
        }
        analyzeLog(`reuse analyze failed PC ${row.program} “${title}” — will recapture`)
      }

      deps.setScan({
        phase: 'capturing',
        collected: captured,
        message: `Song ${index}: “${title}” — selecting in Cubase…`
      })
      analyzeLog(`prep PC ${row.program} “${title}”`)

      let prep: CubaseLengthRead = {
        ok: false,
        mmss: '',
        seconds: 0,
        rawLength: '',
        rawStart: '',
        rawEnd: '',
        infoName: '',
        nameMatched: false,
        source: 'none',
        error: 'not prepared'
      }
      for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS && !deps.isCancelled(); attempt++) {
        await deps.minimizeUi()
        try {
          prep = await cubaseRenderPrepare(title)
        } finally {
          await deps.restoreUi()
        }
        if (isUsablePrep(prep, title) || !prep.infoName || titlesFuzzyMatch(title, prep.infoName)) {
          break
        }
        analyzeLog(
          `prep retry ${attempt}/${CAPTURE_ATTEMPTS} PC ${row.program} “${title}” — Cubase name “${prep.infoName}”`
        )
        await deps.sleep(800)
      }

      if (deps.isCancelled()) return

      if (!isUsablePrep(prep, title) && prep.infoName && !titlesFuzzyMatch(title, prep.infoName)) {
        analyzeLog(`skip PC ${row.program} “${title}” — Cubase name mismatch (${prep.infoName})`)
        return
      }

      const durationSec = captureDurationSec(prep.mmss, row)
      if (durationSec < MIN_CAPTURE_SEC) {
        analyzeLog(`skip “${title}” — length too short (${durationSec}s)`)
        return
      }

      const renderPath = cubaseRenderPathForSong(row.program, title)
      deps.setScan({
        message: `Song ${index}: “${title}” — recording Cubase output (${prep.mmss || row.length})…`
      })

      let ok = false
      for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS && !deps.isCancelled(); attempt++) {
        analyzeLog(`capture ${attempt}/${CAPTURE_ATTEMPTS} PC ${row.program} “${title}” ${durationSec}s`)
        await deps.minimizeUi()
        try {
          ok = await captureRenderedPlayback(deps, renderPath, durationSec)
        } finally {
          await deps.restoreUi()
        }
        if (ok) break
        analyzeLog(`capture failed ${attempt}/${CAPTURE_ATTEMPTS} “${title}”`)
        await cubasePsStop()
        await deps.sleep(1000)
      }

      if (deps.isCancelled()) return
      if (!ok) {
        analyzeLog(`FAILED capture “${title}”`)
        return
      }

      deps.setScan({ phase: 'analyzing', message: `Song ${index}: “${title}” — analyzing render…` })
      const analyzed = await analyzeRenderFile(deps, row, renderPath)
      if (!analyzed) {
        analyzeLog(`FAILED analyze “${title}”`)
        return
      }

      persistAnalysis(row, renderPath, analyzed, row.length || prep.mmss)
    }

    for (let i = 0; i < planned.length && !deps.isCancelled(); i++) {
      await processSong(planned[i], i + 1)
    }

    const doneMsg =
      captured > 0
        ? `Done — ${captured} song(s) analyzed from Cubase renders.`
        : 'Finished — no songs captured (check Stereo Mix + Cubase output).'
    analyzeLog(doneMsg)
    deps.setScan({
      active: false,
      phase: 'complete',
      collected: captured,
      message: doneMsg
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
