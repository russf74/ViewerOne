import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cubasePsStop, cubasePsPlay, prepareCubaseWindowForCapture } from './cubaseLengthCapture.js'
import { cubaseRenderPathForSong } from './cubaseRenderPaths.js'
import type { LightingAnalyzeScanState, SetlistItem } from '../shared/types.js'
import type { SongAudioAnalysis } from '../shared/audioAnalysis.js'
import type { LightingProgram } from '../shared/lightingProgram.js'
import { LoopbackRecorder } from './loopbackRecord.js'
import { peakNormalizeWavFile } from './wavNormalize.js'
import { songLengthSeconds } from '../shared/setlistTiming.js'
import type { LightingDirector } from './lightingDirector.js'
import { copyCaptureWavForMoises, moisesWavExists, moisesWavPath } from './moisesExport.js'

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

function listedDurationSec(row: SetlistItem): number {
  return row.length ? songLengthSeconds(row.length) : 0
}

function captureDurationSec(row: SetlistItem): number {
  return listedDurationSec(row)
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

function isSoundcheckTitle(title: string): boolean {
  return title.toUpperCase().includes('SOUNDCHECK')
}

function shouldCaptureSong(row: SetlistItem, allowSoundcheck = false): boolean {
  const t = row.title.toUpperCase()
  if (isSoundcheckTitle(row.title) && !allowSoundcheck) return false
  if (t.startsWith('INTRO') || t.startsWith('OUTRO')) return false
  return row.program >= 1 && row.program <= 119
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
      // Space only. MIDI Start plus Space toggles transport off when MIDI Start
      // actually rolls (SOUNDCHECK after rewind) and records silence.
      await cubasePsPlay()
      await deps.sleep(durationMs + 800)
      deps.sendAnalyzeStop()
      await cubasePsStop()
      await deps.sleep(200)
      await recorder.stop()
      await deps.sleep(120)
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 1000) return false
      try {
        const gained = await peakNormalizeWavFile(outputPath)
        analyzeLog(
          `gain ${gained.peakBefore.toFixed(4)} → ${gained.peakAfter.toFixed(4)} (peak-normalize, Cubase/Windows fader not used)`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        analyzeLog(msg)
        return false
      }
      const peak = wavFilePeak(outputPath)
      const hdr = wavHeader(outputPath)
      analyzeLog(
        `capture peak ${peak.toFixed(4)} ${hdr.sampleRate}Hz ${hdr.durationSec.toFixed(3)}s (${outputPath})`
      )
      if (peak < 0.2) {
        analyzeLog('capture still too quiet after gain')
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
} | null> {
  try {
    return await deps.director.analyzeFromRenderWav(song, filePath)
  } catch (err) {
    console.warn('[ViewerOne] Render analyze failed:', err)
    return null
  }
}

function exportMoisesWav(row: SetlistItem, wavPath: string): void {
  const dest = moisesWavPath(row.program, row.title)
  if (moisesWavExists(dest) && path.resolve(wavPath) !== path.resolve(dest)) {
    try {
      if (fs.statSync(wavPath).size === fs.statSync(dest).size) {
        analyzeLog(`wav already ${path.basename(dest)}`)
        return
      }
    } catch {
      /* rewrite */
    }
  }
  try {
    copyCaptureWavForMoises(wavPath, dest)
    analyzeLog(`wav ${path.basename(dest)}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    analyzeLog(`wav FAILED ${path.basename(dest)} — ${msg}`)
  }
}

/**
 * Walk Cubase arranger and capture REAL rendered audio per song (loopback during playback).
 * Sidecar-only — never runs automatically; does not modify arranger scan or gig countdown.
 * After each capture (or reuse), copies the 48 kHz Cubase WAV to Desktop/Moises-upload.
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
    await cubasePsStop()
    await prepareCubaseWindowForCapture()
    if (deps.isCancelled()) {
      deps.setScan({ active: false, phase: 'cancelled', message: 'Cancelled.' })
      return
    }

    const onlyTitle = deps.onlyTitle?.trim()
    const onlyProgram =
      deps.onlyProgram && deps.onlyProgram > 0 ? Math.round(deps.onlyProgram) : undefined
    const wantTitle = onlyTitle
      ? onlyTitle.toLowerCase().replace(/[^a-z0-9]+/g, '')
      : ''
    const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const allowSoundcheck = (row: SetlistItem): boolean => {
      if (!isSoundcheckTitle(row.title)) return false
      if (onlyProgram && row.program === onlyProgram) return true
      if (wantTitle && titleKey(row.title) === wantTitle) return true
      return false
    }
    const wantsCapture = (row: SetlistItem): boolean => {
      if (!shouldCaptureSong(row, allowSoundcheck(row)) || row.arrangerIndex == null) return false
      if (onlyProgram && row.program !== onlyProgram) return false
      if (wantTitle && titleKey(row.title) !== wantTitle) {
        return false
      }
      return true
    }
    const walkOrder = setlist
      .filter((r) => r.arrangerIndex != null)
      .sort((a, b) => (a.arrangerIndex ?? 0) - (b.arrangerIndex ?? 0))
    const planned = walkOrder.filter(wantsCapture)
    if ((onlyTitle || onlyProgram) && planned.length === 0) {
      const msg = `No setlist song matches ${onlyProgram ? `PC ${onlyProgram}` : ''} ${onlyTitle ? `“${onlyTitle}”` : ''}`.trim()
      analyzeLog(msg)
      deps.setScan({ active: false, phase: 'error', message: msg })
      return
    }
    const limit = deps.maxCaptures && deps.maxCaptures > 0 ? deps.maxCaptures : planned.length
    deps.setScan({ total: Math.min(limit, planned.length) })
    analyzeLog(
      `walk ${walkOrder.length} arranger event(s) first→last: ` +
        walkOrder.map((r) => `${r.arrangerIndex}. PC${r.program} ${r.title}`).join(' → ')
    )
    analyzeLog(
      `capture ${Math.min(limit, planned.length)} song(s) ` +
        `(${planned.some((r) => isSoundcheckTitle(r.title)) ? 'include SOUNDCHECK, skip INTRO/OUTRO' : 'skip SOUNDCHECK/INTRO/OUTRO'}, no title-click)`
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
        length: length || row.length
      })
      captured++
      deps.setScan({ collected: captured })
      analyzeLog(
        `OK PC ${row.program} “${row.title}” → ${analyzed.audioAnalysis.bpm} BPM, ${analyzed.lightingProgram.cues.length} cues`
      )
    }

    const rowForProgram = (program: number): SetlistItem | undefined =>
      setlist.find((r) => r.program === program)

    const captureCurrentSong = async (row: SetlistItem, index: number): Promise<void> => {
      const title = row.title.trim()
      const livePc = deps.getLatestProgram()
      if (livePc !== row.program) {
        analyzeLog(
          `refuse play PC ${row.program} “${title}” — Cubase is PC ${livePc ?? 'none'} (would be the wrong song)`
        )
        return
      }

      const durationSec = captureDurationSec(row)
      if (durationSec < MIN_CAPTURE_SEC) {
        analyzeLog(`skip “${title}” — setlist length too short (${durationSec}s)`)
        return
      }

      const renderPath = cubaseRenderPathForSong(row.program, title)
      deps.setScan({
        phase: 'capturing',
        collected: captured,
        message: `Song ${index}: “${title}” — recording Cubase (${row.length || `${durationSec}s`})…`
      })

      let ok = false
      for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS && !deps.isCancelled(); attempt++) {
        if (deps.getLatestProgram() !== row.program) {
          analyzeLog(
            `abort capture “${title}” — Cubase moved to PC ${deps.getLatestProgram()}`
          )
          return
        }
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

      if (deps.isCancelled() || !ok) {
        if (!ok && !deps.isCancelled()) analyzeLog(`FAILED capture “${title}”`)
        return
      }

      exportMoisesWav(row, renderPath)

      deps.setScan({ phase: 'analyzing', message: `Song ${index}: “${title}” — analyzing render…` })
      const analyzed = await analyzeRenderFile(deps, row, renderPath)
      if (!analyzed) {
        deps.updateRow(row.id, {
          audioSource: 'cubase-render',
          cubaseRenderPath: renderPath,
          cubaseRenderCapturedAt: new Date().toISOString()
        })
        captured++
        deps.setScan({ collected: captured })
        analyzeLog(`FAILED analyze “${title}” — wav kept`)
        return
      }

      persistAnalysis(row, renderPath, analyzed, row.length)
    }

    const alreadyHaveWav = (row: SetlistItem): boolean =>
      moisesWavExists(moisesWavPath(row.program, row.title))
    const recaptureOne = Boolean(onlyTitle || onlyProgram)
    const missingPlanned = (): SetlistItem[] =>
      planned.filter((r) => recaptureOne || !alreadyHaveWav(r)).slice(0, limit)

    const walkArranger = async (): Promise<void> => {
      analyzeLog('rewind arranger to first event (no playback)')
      await cubasePsStop()
      await deps.rewindArranger()
      await deps.sleep(600)
      let pc = deps.getLatestProgram()
      analyzeLog(`after rewind Cubase PC ${pc ?? 'none'}`)

      const visited = new Set<number>()
      while (pc != null && !deps.isCancelled() && captured < limit) {
        if (visited.has(pc)) {
          analyzeLog(`arranger wrapped at PC ${pc}`)
          break
        }
        visited.add(pc)
        const row = rowForProgram(pc)
        const label = row?.title ?? '?'
        if (!row || !shouldCaptureSong(row, allowSoundcheck(row))) {
          analyzeLog(`skip PC ${pc} “${label}” — no playback (SOUNDCHECK/INTRO/OUTRO)`)
        } else if (wantsCapture(row) && !recaptureOne && alreadyHaveWav(row)) {
          analyzeLog(`have wav PC ${pc} “${label}” — keep, step Next`)
        } else if (wantsCapture(row)) {
          songNumber++
          analyzeLog(`landed ${row.arrangerIndex}. PC ${pc} “${label}” — capture`)
          await captureCurrentSong(row, songNumber)
          await cubasePsStop()
          await deps.sleep(400)
        } else {
          analyzeLog(`skip PC ${pc} “${label}” — filtered`)
        }

        // Playback often advances Cubase to the next event. Another Next would skip a song.
        const already = deps.getLatestProgram()
        if (already != null && already !== pc) {
          analyzeLog(`Cubase already on PC ${already} — no extra Next`)
          pc = already
          continue
        }
        const next = await deps.waitForProgramChange(pc)
        if (next == null) {
          analyzeLog('end of arranger (Next did not change song)')
          break
        }
        pc = next
      }
    }

    let songNumber = 0
    await walkArranger()

    let gaps = missingPlanned()
    if (gaps.length > 0 && !deps.isCancelled()) {
      analyzeLog(
        `gaps after walk: ${gaps.map((r) => `PC${r.program} ${r.title}`).join('; ')} — rewind and retry`
      )
      await walkArranger()
      gaps = missingPlanned()
    }
    for (const row of gaps) {
      if (deps.isCancelled() || captured >= limit) break
      analyzeLog(`gap restore PC ${row.program} “${row.title}”`)
      await cubasePsStop()
      await deps.restoreProgram(row.program)
      await deps.sleep(500)
      if (deps.getLatestProgram() !== row.program) {
        analyzeLog(`gap restore failed — Cubase is PC ${deps.getLatestProgram()}`)
        continue
      }
      songNumber++
      await captureCurrentSong(row, songNumber)
      await cubasePsStop()
    }
    gaps = missingPlanned()
    if (gaps.length) {
      analyzeLog(`still missing: ${gaps.map((r) => `PC${r.program} ${r.title}`).join('; ')}`)
    }

    const haveCount = planned.length - missingPlanned().length
    const doneMsg =
      haveCount > 0
        ? `Done — ${haveCount}/${planned.length} song WAVs in Desktop\\Moises-upload` +
          (gaps.length ? ` (missing ${gaps.length}).` : '.')
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
