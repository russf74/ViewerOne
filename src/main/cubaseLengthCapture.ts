import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { createWorker, type Worker } from 'tesseract.js'
import { formatSetlistSeconds, normalizeSongLength, songLengthSeconds } from '../shared/setlistTiming.js'

export type CubaseLengthRead = {
  ok: boolean
  mmss: string
  seconds: number
  rawLength: string
  rawStart: string
  rawEnd: string
  /** OCR'd Info Line Name value (may be empty). */
  infoName: string
  /** True when infoName fuzzy-matches the expected event title. */
  nameMatched: boolean
  source: 'length' | 'start-end' | 'none'
  error?: string
  noObjectSelected?: boolean
}

export type CubaseWindowPrep = {
  ok: boolean
  prepared?: boolean
  /** Geometry is left alone (no maximize / SetWindowPos). */
  moved?: boolean
  restored?: boolean
  process?: string
  title?: string
  left?: number
  top?: number
  width?: number
  height?: number
  error?: string
}

export type CubaseHealth = {
  ok: boolean
  alive: boolean
  hasWindow?: boolean
  process?: string
  pid?: number
  title?: string
  error?: string
}

/**
 * Auto length pass during Arranger scan (5.12.53).
 * Clicks the Arranger *timeline event block* (real mouse, cursor restored) so Cubase
 * fills the Info Line. Inspector-list clicks were wrong (play-arrow starts playback;
 * chain highlight ≠ object selected). Length is written only when Name matches.
 */
export const CUBASE_AUTO_LENGTH_PASS = true

/**
 * Do not click Cubase. Scan uses MIDI Next/Prev; length is OCR of the Info Line.
 */
export const CUBASE_ARRANGER_AUTO_CLICK = true

/** Reject 00:34-style garbage and sub-minute misreads. Typical songs are 3–5 minutes. */
export const LENGTH_SANITY_MIN_SEC = 90
export const LENGTH_SANITY_MAX_SEC = 30 * 60

type PsCaptureResult = {
  ok: boolean
  noObjectSelected?: boolean
  error?: string
  infoName?: string
  startPng?: string
  endPng?: string
  lengthPng?: string
  valueY?: number
  ocrText?: string
  window?: { left?: number; top?: number; width?: number; height?: number; moved?: boolean }
}

type PsClickResult = {
  ok: boolean
  error?: string
  clicked?: string
  x?: number
  y?: number
  score?: number
  method?: string
}

let tesseractWorker: Worker | null = null
let tesseractReady: Promise<Worker> | null = null
/** tesseract.js workers are not safe for concurrent recognize() — serialize all OCR. */
let ocrQueue: Promise<unknown> = Promise.resolve()

const POWERSHELL_TIMEOUT_MS = 22_000
/** Grab may retry clicks + Info Line OCR; needs longer than a single capture. */
const POWERSHELL_GRAB_TIMEOUT_MS = 75_000
const TESSERACT_TIMEOUT_MS = 25_000
const BETWEEN_SONG_MS = 0

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function scriptPath(): string {
  const candidates = [
    path.join(app.getAppPath(), 'scripts', 'cubase-info-line.ps1'),
    path.join(process.cwd(), 'scripts', 'cubase-info-line.ps1'),
    path.join(__dirname, '..', '..', 'scripts', 'cubase-info-line.ps1')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(`cubase-info-line.ps1 not found (tried ${candidates.join(', ')})`)
}

/**
 * Always invoke via absolute powershell.exe + -File.
 * Never Start-Process / shell-open a .ps1 (Windows associates .ps1 → Notepad).
 * Never spawn the .ps1 path as the executable.
 */
function powershellExe(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe'
  ]
  for (const p of candidates) {
    if (p === 'powershell.exe' || fs.existsSync(p)) return p
  }
  return candidates[0]!
}

let psHost: ChildProcess | null = null
let psHostBuf = ''
let psHostPending: {
  resolve: (line: string) => void
  reject: (err: Error) => void
} | null = null
let psHostQueue: Promise<unknown> = Promise.resolve()

function stopPsHost(): void {
  const proc = psHost
  psHost = null
  psHostBuf = ''
  if (psHostPending) {
    psHostPending.reject(new Error('Cubase OCR helper restarted'))
    psHostPending = null
  }
  if (proc && proc.exitCode == null) {
    try {
      proc.stdin?.write('quit\n')
    } catch {
      /* ignore */
    }
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
}

/** Politely stop the PowerShell OCR helper and Tesseract worker before Electron exits. */
export async function shutdownCubaseLengthCapture(): Promise<void> {
  const proc = psHost
  psHost = null
  psHostBuf = ''
  if (psHostPending) {
    try {
      psHostPending.reject(new Error('ViewerOne quitting'))
    } catch {
      /* ignore */
    }
    psHostPending = null
  }
  if (proc && proc.exitCode == null) {
    try {
      proc.stdin?.write('quit\n')
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 400)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  const tess = resetTesseractWorker()
  await Promise.race([
    tess,
    new Promise<void>((resolve) => setTimeout(resolve, 800))
  ])
}

function ensurePsHost(): ChildProcess {
  if (psHost && psHost.exitCode == null) return psHost
  stopPsHost()
  const proc = spawn(
    powershellExe(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), 'serve', tempWorkDir()],
    { windowsHide: true, shell: false }
  )
  psHost = proc
  psHostBuf = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    psHostBuf += chunk.toString('utf8')
    const nl = psHostBuf.indexOf('\n')
    if (nl < 0 || !psHostPending) return
    const line = psHostBuf.slice(0, nl).trim()
    psHostBuf = psHostBuf.slice(nl + 1)
    const pending = psHostPending
    psHostPending = null
    pending.resolve(line)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn('[ViewerOne] Cubase OCR helper:', text.slice(0, 300))
  })
  proc.on('exit', (code) => {
    if (psHost === proc) psHost = null
    if (psHostPending) {
      const pending = psHostPending
      psHostPending = null
      pending.reject(new Error(`Cubase OCR helper exited ${code ?? 'null'}`))
    }
  })
  return proc
}

function runOnPsHost(args: string[], timeoutMs: number): Promise<string> {
  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const proc = ensurePsHost()
      if (!proc.stdin) {
        reject(new Error('Cubase OCR helper has no stdin'))
        return
      }
      const action = args[0] ?? 'grab'
      const outDir = args[1] ?? tempWorkDir()
      const eventName = args.slice(2).join(' ')
      const timer = setTimeout(() => {
        if (psHostPending) {
          psHostPending = null
          stopPsHost()
          reject(new Error(`PowerShell host timed out after ${timeoutMs}ms (${action})`))
        }
      }, timeoutMs)
      psHostPending = {
        resolve: (line) => {
          clearTimeout(timer)
          resolve(line)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      }
      try {
        proc.stdin.write(`${action}\t${outDir}\t${eventName}\n`)
      } catch (err) {
        clearTimeout(timer)
        psHostPending = null
        stopPsHost()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  const next = psHostQueue.then(run, run)
  psHostQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function runPowershell(args: string[], timeoutMs = POWERSHELL_TIMEOUT_MS): Promise<string> {
  const action = args[0] ?? ''
  if (
    action === 'grab' ||
    action === 'health' ||
    action === 'prepare' ||
    action === 'click' ||
    action === 'capture' ||
    action === 'expand' ||
    action === 'renderprep' ||
    action === 'stop' ||
    action === 'play' ||
    action === 'zoom'
  ) {
    return runOnPsHost(args, timeoutMs)
  }
  return new Promise((resolve, reject) => {
    const script = scriptPath()
    const ps = spawn(
      powershellExe(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, shell: false }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ps.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`PowerShell timed out after ${timeoutMs}ms (${args[0] ?? 'action'})`))
    }, timeoutMs)
    ps.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    ps.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    ps.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    ps.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited ${code}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

function parseJsonLine<T>(raw: string): T {
  const jsonLine = raw.split(/\r?\n/).filter(Boolean).pop() || raw
  return JSON.parse(jsonLine) as T
}

async function resetTesseractWorker(): Promise<void> {
  const prior = tesseractWorker
  tesseractWorker = null
  tesseractReady = null
  if (prior) {
    try {
      await prior.terminate()
    } catch {
      /* ignore */
    }
  }
}

async function getTesseract(): Promise<Worker> {
  if (tesseractWorker) return tesseractWorker
  if (!tesseractReady) {
    tesseractReady = (async () => {
      const worker = await createWorker('eng')
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789:. ',
        tessedit_pageseg_mode: '7'
      })
      tesseractWorker = worker
      return worker
    })()
  }
  return tesseractReady
}

/** Normalize common Cubase OCR mangling before parse. */
export function normalizeCubaseOcrText(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .replace(/[OoDd]/g, '0')
    .replace(/[Il]/g, '1')
    .replace(/[Ss]/g, ':')
    .replace(/[|=]/g, ':')
    .replace(/[,]/g, '.')
    .replace(/[^0-9:.]/g, '')
}

export function normalizeTitleKey(raw: string): string {
  let s = String(raw ?? '')
    .toLowerCase()
    .replace(/[''`´]/g, '')
    .replace(/\b1m\b/g, 'im')
    .replace(/\b1\b(?=\s*[a-z])/g, 'i')
    .replace(/\b5oundcheck\b/g, 'soundcheck')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (/^(end songs|end song)\b/.test(s)) s = 'outro'
  if (/^outro\b/.test(s)) s = `outro ${s.replace(/^outro\s*/, '')}`.trim()
  // Cubase / OCR often splits it: "Sound Check" vs setlist "Soundcheck (Reflex)".
  if (/^sound check\b/.test(s)) s = `soundcheck ${s.replace(/^sound check\s*/, '')}`.trim()
  return s
}

function compactTitleKey(s: string): string {
  return s.replace(/[^a-z0-9]/g, '')
}

function isSoundcheckTitleKey(s: string): boolean {
  const c = compactTitleKey(s)
  return c.startsWith('soundcheck') || c.startsWith('5oundcheck')
}

/** Fuzzy title match for Info Line Name vs setlist song title. */
export function titlesFuzzyMatch(expected: string, actual: string): boolean {
  const a = normalizeTitleKey(expected)
  const b = normalizeTitleKey(actual)
  if (!a || !b) return false
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  if (isSoundcheckTitleKey(a) && isSoundcheckTitleKey(b)) return true
  const section = (s: string) => s.split(' ')[0]
  const a0 = section(a)
  const b0 = section(b)
  if (a0 === b0 && ['intro', 'outro', 'soundcheck'].includes(a0)) return true
  const compactA = a.replace(/[^a-z0-9]/g, '')
  const compactB = b.replace(/[^a-z0-9]/g, '')
  if (compactA.length >= 6 && compactB.length >= 5) {
    if (compactA.startsWith(compactB.slice(0, 5)) || compactB.startsWith(compactA.slice(0, 5))) return true
    const consonants = (s: string) => s.replace(/[aeiou]/g, '')
    const ca = consonants(compactA)
    const cb = consonants(compactB)
    if (ca.length >= 5 && cb.length >= 4 && (ca.includes(cb) || cb.includes(ca))) return true
  }
  const aWords = a.split(' ').filter((w) => w.length > 2)
  const bWords = b.split(' ').filter((w) => w.length > 2)
  if (aWords.length >= 2 && b.length > a.length + 10) {
    const hits = aWords.filter((w) => b.includes(w)).length
    if (hits >= Math.min(2, aWords.length) && hits / aWords.length >= 0.5) return true
  }
  if (aWords.length >= 2 && bWords.length >= 2) {
    const overlap = aWords.filter((w) => bWords.includes(w)).length
    if (overlap >= Math.min(2, aWords.length, bWords.length) && overlap / Math.max(aWords.length, bWords.length) >= 0.5) {
      return true
    }
  }
  const prefixLen = Math.min(12, a.length, b.length)
  if (prefixLen >= 8 && (a.startsWith(b.slice(0, prefixLen)) || b.startsWith(a.slice(0, prefixLen)))) {
    return true
  }
  return false
}

export function isSaneSongLengthSeconds(sec: number): boolean {
  return Number.isFinite(sec) && sec >= LENGTH_SANITY_MIN_SEC && sec < LENGTH_SANITY_MAX_SEC
}

export function isKeepableSongLength(mmss: string): boolean {
  return isSaneSongLengthSeconds(songLengthSeconds(mmss))
}

/** Auto-scan: INTRO/OUTRO may be long; real songs (incl. SOUNDCHECK) must look like a single track. */
export const TYPICAL_MAIN_SONG_MAX_SEC = 8 * 60

export function isKeepableLengthForTitle(mmss: string, title: string): boolean {
  if (!isKeepableSongLength(mmss)) return false
  const sec = songLengthSeconds(mmss)
  const t = (title ?? '').trim().toUpperCase()
  if (t.startsWith('INTRO') || t.startsWith('OUTRO')) return true
  return sec <= TYPICAL_MAIN_SONG_MAX_SEC
}

/**
 * If many songs got the exact same length (classic 00:34 bug), treat the batch as garbage.
 * Returns true when the pass should discard all newly written lengths.
 */
export function isDuplicateLengthGarbage(mmssList: string[], songCount: number): boolean {
  const vals = mmssList.map((v) => normalizeSongLength(v)).filter(Boolean)
  if (vals.length < 3) return false
  const counts = new Map<string, number>()
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1)
  let top = 0
  for (const n of counts.values()) if (n > top) top = n
  const threshold = Math.max(3, Math.ceil(Math.min(vals.length, songCount) * 0.6))
  return top >= threshold
}

async function ocrDigits(pngPath: string): Promise<string> {
  if (!pngPath || !fs.existsSync(pngPath)) return ''
  const run = async (): Promise<string> => {
    try {
      const worker = await getTesseract()
      const { data } = await withTimeout(
        worker.recognize(pngPath),
        TESSERACT_TIMEOUT_MS,
        'Tesseract OCR'
      )
      return normalizeCubaseOcrText(data.text || '')
    } catch (err) {
      console.warn(
        '[ViewerOne] Tesseract OCR failed —',
        err instanceof Error ? err.message : String(err)
      )
      await resetTesseractWorker()
      return ''
    }
  }
  const next = ocrQueue.then(run, run)
  ocrQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** Parse Cubase info-line times like `0:03:39.390`, including common OCR mangling. */
export function parseCubaseTimecode(raw: string): number | null {
  const text = normalizeCubaseOcrText(raw)
  if (!text) return null

  const standard = /(\d{1,2}):([0-5]\d):([0-5]\d)(?:[.,](\d{1,4}))?/.exec(text)
  if (standard) {
    const h = Number(standard[1])
    const m = Number(standard[2])
    const s = Number(standard[3])
    let ms = 0
    if (standard[4] != null) {
      ms = Number(standard[4].padEnd(3, '0').slice(0, 3))
    } else {
      const glued = /^(\d{1,2}):([0-5]\d):([0-5]\d)(\d{3})$/.exec(text)
      if (glued) ms = Number(glued[4])
    }
    return h * 3600 + m * 60 + s + ms / 1000
  }

  const missingColon = /(\d{1,2}):(\d{2})(\d{2})(?:[.,](\d{1,4}))?/.exec(text)
  if (missingColon) {
    const h = Number(missingColon[1])
    const m = Number(missingColon[2])
    const s = Number(missingColon[3])
    if (m <= 59 && s <= 59) {
      const ms = Number((missingColon[4] ?? '0').padEnd(3, '0').slice(0, 3))
      return h * 3600 + m * 60 + s + ms / 1000
    }
  }

  const compact = /^(\d+)[.,](\d{1,4})$/.exec(text)
  if (compact) {
    const d = compact[1]
    const ms = Number(compact[2].padEnd(3, '0').slice(0, 3))
    const tryHms = (h: number, m: number, s: number): number | null => {
      if (m <= 59 && s <= 59) return h * 3600 + m * 60 + s + ms / 1000
      return null
    }
    // 0:03:39.390 OCR'd as 010339.390 (colon → 1). Prefer 0:0M:SS over 0:10:SS.
    const digits9 = `${d}${String(compact[2] ?? '').padEnd(3, '0').slice(0, 3)}`
    if (digits9.length === 9) {
      for (let i = 0; i < 9; i++) {
        if (digits9[i] !== '1') continue
        const dropped = digits9.slice(0, i) + digits9.slice(i + 1)
        if (dropped.length !== 8) continue
        const h = Number(dropped[0])
        const m = Number(dropped.slice(1, 3))
        const s = Number(dropped.slice(3, 5))
        const mss = Number(dropped.slice(5, 8))
        const sec = h * 3600 + m * 60 + s + mss / 1000
        if (h <= 12 && m <= 59 && s <= 59 && sec >= 90 && sec <= TYPICAL_MAIN_SONG_MAX_SEC) {
          return sec
        }
      }
    }
    if (d.length === 5) {
      const sec = tryHms(Number(d[0]), Number(d.slice(1, 3)), Number(d.slice(3, 5)))
      if (sec != null) return sec
    }
    if (d.length === 6 && d[0] === '0') {
      const skipped = tryHms(0, Number(d.slice(1, 3)), Number(d.slice(4, 6)))
      if (skipped != null) return skipped
      const asHms = tryHms(Number(d[0]), Number(d.slice(1, 3)), Number(d.slice(3, 5)))
      if (asHms != null) return asHms
    }
    if (d.length === 7 && d[0] === '0') {
      const skipped = tryHms(0, Number(d.slice(2, 4)), Number(d.slice(5, 7)))
      if (skipped != null) return skipped
      const mid = tryHms(0, Number(d.slice(1, 3)), Number(d.slice(4, 6)))
      if (mid != null) return mid
    }
  }

  const digits = text.replace(/\D/g, '')
  const fromHmsMs = (d: string): number | null => {
    if (d.length !== 8) return null
    const h = Number(d[0])
    const m = Number(d.slice(1, 3))
    const s = Number(d.slice(3, 5))
    const ms = Number(d.slice(5, 8))
    if (h > 12 || m > 59 || s > 59) return null
    return h * 3600 + m * 60 + s + ms / 1000
  }
  // Cubase Info Line is always H:MM:SS.mmm → 8 digits. The old 8-digit MM:SS.mmm
  // path turned 0:03:39.950 into 00:34.
  const hms = fromHmsMs(digits)
  if (hms != null) return hms
  if (digits.length === 9) {
    for (let i = 0; i < 9; i++) {
      if (digits[i] !== '1') continue
      const dropped = fromHmsMs(digits.slice(0, i) + digits.slice(i + 1))
      if (dropped != null) return dropped
    }
  }
  if (digits.length === 7) {
    const padded = fromHmsMs(`0${digits}`)
    if (padded != null) return padded
  }
  if (digits.length === 10 && digits[0] === '0') {
    return fromHmsMs(digits.slice(0, 8))
  }

  return null
}

export function cubaseSecondsToMmss(totalSeconds: number): string {
  return normalizeSongLength(formatSetlistSeconds(Math.round(totalSeconds)))
}

function tempWorkDir(): string {
  const dir = path.join(os.tmpdir(), 'viewerone-cubase-length')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const LENGTH_PASS_SONG_GAP_MS = BETWEEN_SONG_MS

function emptyRead(error: string, extra?: Partial<CubaseLengthRead>): CubaseLengthRead {
  return {
    ok: false,
    mmss: '',
    seconds: 0,
    rawLength: '',
    rawStart: '',
    rawEnd: '',
    infoName: '',
    nameMatched: false,
    source: 'none',
    error,
    ...extra
  }
}

/** Soft restore only if minimized. Never maximize / SetWindowPos. */
export async function prepareCubaseWindowForCapture(): Promise<CubaseWindowPrep> {
  const outDir = tempWorkDir()
  try {
    const raw = await runPowershell(['prepare', outDir])
    const result = parseJsonLine<CubaseWindowPrep>(raw)
    if (result.ok) {
      console.log(
        `[ViewerOne] Cubase window prepared — ${result.process ?? '?'} ` +
          `"${result.title ?? ''}" ${result.width}x${result.height}` +
          ` @ ${result.left},${result.top}` +
          `${result.restored ? ' (restored)' : ''}` +
          ' (geometry left alone; no maximize)'
      )
    }
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[ViewerOne] Cubase window prepare failed — ${message}`)
    return { ok: false, error: message }
  }
}

/** Grow Cubase height a bit and thicken the Arranger Track lane (no Zoom Full). */
export async function expandCubaseArrangerLayout(): Promise<{
  ok: boolean
  windowGrown?: boolean
  height?: number
  laneBefore?: number
  laneAfter?: number
  laneGrew?: boolean
  error?: string
}> {
  const outDir = tempWorkDir()
  try {
    const raw = await runPowershell(['expand', outDir], 90_000)
    const result = parseJsonLine<{
      ok: boolean
      windowGrown?: boolean
      height?: number
      laneBefore?: number
      laneAfter?: number
      laneGrew?: boolean
      error?: string
    }>(raw)
    if (result.ok) {
      console.log(
        `[ViewerOne] Cubase Arranger layout expanded — height ${result.height ?? '?'} ` +
          `lane ${result.laneBefore ?? '?'}→${result.laneAfter ?? '?'}px` +
          `${result.windowGrown ? ' (window grown)' : ''}`
      )
    }
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[ViewerOne] Cubase Arranger expand failed — ${message}`)
    return { ok: false, error: message }
  }
}

/** True when Cubase process (+ preferably HWND) is still present. */
export async function checkCubaseAlive(): Promise<CubaseHealth> {
  const outDir = tempWorkDir()
  try {
    const raw = await runPowershell(['health', outDir], 12_000)
    return parseJsonLine<CubaseHealth>(raw)
  } catch (err) {
    return {
      ok: false,
      alive: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * OCR-locate Arranger timeline event, then ONE real mouse click (cursor restored).
 * Never inspector (play-arrow), never bottom transport/metronome.
 */
export async function clickCubaseArrangerEvent(eventName: string): Promise<PsClickResult> {
  if (!CUBASE_ARRANGER_AUTO_CLICK) {
    return {
      ok: false,
      error: 'Arranger auto-click disabled'
    }
  }
  try {
    const health = await checkCubaseAlive()
    if (!health.alive) {
      return { ok: false, error: health.error || 'Cubase not running' }
    }
    const outDir = tempWorkDir()
    const raw = await runPowershell(['click', outDir, eventName])
    const result = parseJsonLine<PsClickResult>(raw)
    const after = await checkCubaseAlive()
    if (!after.alive) {
      return {
        ok: false,
        error: 'Cubase exited after Arranger click — aborting further clicks',
        clicked: result.clicked,
        method: result.method || 'mouse-timeline-event'
      }
    }
    return result
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

type PsGrabResult = {
  ok?: boolean
  clickedOk?: boolean
  clicked?: string
  clickError?: string
  x?: number
  y?: number
  noObjectSelected?: boolean
  infoName?: string
  rawStart?: string
  rawEnd?: string
  rawLength?: string
  ocrText?: string
  timesPng?: string
  lengthPng?: string
  namePng?: string
  error?: string
}

function extractTimecodes(text: string): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const push = (sec: number | null): void => {
    if (sec == null || seen.has(Math.round(sec * 1000))) return
    seen.add(Math.round(sec * 1000))
    out.push(sec)
  }
  push(parseCubaseTimecode(text))
  const re = /(\d{1,2}:[0-5]\d:[0-5]\d(?:[.,]\d{1,4})?|\d{5,10}[.,]\d{1,4}|[0O]:\d{2}[:S]\d+[.,]?\d*)/gi
  let m: RegExpExecArray | null
  const raw = String(text ?? '')
  while ((m = re.exec(raw))) {
    push(parseCubaseTimecode(m[0]))
  }
  for (const part of raw.split(/[\s|/]+/)) {
    if (part.length >= 5) push(parseCubaseTimecode(part))
  }
  return out
}

function pickSongLengthSeconds(
  lengthSec: number | null,
  startSec: number | null,
  endSec: number | null,
  blobTimes: number[]
): { seconds: number; source: CubaseLengthRead['source'] } | null {
  const fromSpan =
    startSec != null && endSec != null && endSec > startSec ? endSec - startSec : null
  if (fromSpan != null && isSaneSongLengthSeconds(fromSpan)) {
    if (lengthSec != null && isSaneSongLengthSeconds(lengthSec) && Math.abs(fromSpan - lengthSec) > 2.5) {
      const typical = (s: number) => s >= LENGTH_SANITY_MIN_SEC && s <= TYPICAL_MAIN_SONG_MAX_SEC
      if (typical(fromSpan) && !typical(lengthSec)) {
        return { seconds: fromSpan, source: 'start-end' }
      }
      if (typical(lengthSec) && !typical(fromSpan)) {
        return { seconds: lengthSec, source: 'length' }
      }
      if (typical(fromSpan) && typical(lengthSec)) {
        return Math.abs(lengthSec - 240) <= Math.abs(fromSpan - 240)
          ? { seconds: lengthSec, source: 'length' }
          : { seconds: fromSpan, source: 'start-end' }
      }
      const lengthLooksLong = lengthSec >= 12 * 60
      if (lengthLooksLong && typical(fromSpan)) {
        return { seconds: fromSpan, source: 'start-end' }
      }
      return { seconds: lengthSec, source: 'length' }
    }
    return { seconds: fromSpan, source: 'start-end' }
  }
  if (lengthSec != null && isSaneSongLengthSeconds(lengthSec)) {
    return { seconds: lengthSec, source: 'length' }
  }
  const sane = [lengthSec, fromSpan, ...blobTimes].filter(
    (v): v is number => v != null && isSaneSongLengthSeconds(v)
  )
  if (sane.length) {
    // Prefer a typical song (2–8 min) over a project-position End time that slipped through.
    sane.sort((a, b) => Math.abs(a - 240) - Math.abs(b - 240))
    const source: CubaseLengthRead['source'] =
      lengthSec != null && Math.abs(sane[0]! - lengthSec) < 1.5 ? 'length' : 'start-end'
    return { seconds: sane[0]!, source }
  }
  return null
}

function readFromRawTimes(
  expectedTitle: string | undefined,
  infoName: string,
  ocrBlob: string,
  rawLength: string,
  rawStart: string,
  rawEnd: string,
  noObjectSelected: boolean,
  extraError?: string
): CubaseLengthRead {
  if (noObjectSelected) {
    return emptyRead('Cubase info line shows No Object Selected', { noObjectSelected: true })
  }
  const blob = `${infoName} ${ocrBlob} ${rawLength} ${rawStart} ${rawEnd}`
  const nameMatched = expectedTitle
    ? Boolean(
        infoName &&
          !/^\d+\s*[-–]/.test(infoName.trim()) &&
          titlesFuzzyMatch(expectedTitle, infoName)
      )
    : Boolean(infoName)
  const lengthSec = parseCubaseTimecode(rawLength)
  const startSec = parseCubaseTimecode(rawStart)
  const endSec = parseCubaseTimecode(rawEnd)
  const picked = pickSongLengthSeconds(lengthSec, startSec, endSec, extractTimecodes(blob))
  // Empty Name is not a match — leftover Info Line (e.g. INTRO 10:51) must not be written
  // onto the next song just because OCR missed the title.
  if (expectedTitle && !nameMatched) {
    return {
      ok: false,
      mmss: '',
      seconds: picked?.seconds ?? 0,
      rawLength,
      rawStart,
      rawEnd,
      infoName,
      nameMatched: false,
      source: 'none',
      error: extraError
        ? extraError
        : infoName
          ? `Info Line Name “${infoName}” does not match “${expectedTitle}” — length not written`
          : `Info Line Name empty (still “${expectedTitle}”? click may have missed the Arranger event)`
    }
  }
  if (picked) {
    const mmss = cubaseSecondsToMmss(picked.seconds)
    return {
      ok: Boolean(mmss),
      mmss,
      seconds: picked.seconds,
      rawLength,
      rawStart,
      rawEnd,
      infoName,
      nameMatched: expectedTitle ? nameMatched : Boolean(infoName),
      source: picked.source
    }
  }
  const bad = lengthSec ?? (startSec != null && endSec != null && endSec > startSec ? endSec - startSec : null)
  if (bad != null) {
    return {
      ok: false,
      mmss: '',
      seconds: bad,
      rawLength,
      rawStart,
      rawEnd,
      infoName,
      nameMatched,
      source: 'none',
      error: `Length ${cubaseSecondsToMmss(bad) || bad.toFixed(1) + 's'} outside sanity (${LENGTH_SANITY_MIN_SEC}s–${LENGTH_SANITY_MAX_SEC / 60}min)`
    }
  }
  return emptyRead(
    extraError ||
      `Could not parse Length/Start/End (got Length="${rawLength}" Start="${rawStart}" End="${rawEnd}" ocr="${ocrBlob.slice(0, 80)}")`,
    { infoName, nameMatched, rawLength, rawStart, rawEnd }
  )
}

function isUsableLengthRead(read: CubaseLengthRead, title = ''): boolean {
  return Boolean(
    read.ok &&
      read.nameMatched &&
      read.mmss &&
      (title ? isKeepableLengthForTitle(read.mmss, title) : isKeepableSongLength(read.mmss))
  )
}

/** OCR the Cubase Info Line. No mouse/keyboard in Cubase — MIDI Next/Prev does the walk. */
export async function grabCubaseEventLength(eventName: string): Promise<CubaseLengthRead> {
  const title = eventName.trim()
  try {
    const outDir = tempWorkDir()
    const raw = await runPowershell(['grab', outDir, title], POWERSHELL_GRAB_TIMEOUT_MS)
    const grab = parseJsonLine<PsGrabResult>(raw)
    console.log(
      `[ViewerOne] Cubase length OCR “${title}”: name="${String(grab.infoName || '').trim()}" ` +
        `len=${grab.rawLength || ''} start=${grab.rawStart || ''} end=${grab.rawEnd || ''}`
    )
    try {
      fs.writeFileSync(
        path.join(tempWorkDir(), 'last-grab-log.txt'),
        [
          `title=${title}`,
          `infoName=${grab.infoName || ''}`,
          `rawLength=${grab.rawLength || ''}`,
          `rawStart=${grab.rawStart || ''}`,
          `rawEnd=${grab.rawEnd || ''}`,
          `clicked=${grab.clicked || ''}`,
          `timesPng=${grab.timesPng || ''}`,
          `error=${grab.error || ''}`,
          `at=${new Date().toISOString()}`
        ].join('\n'),
        'utf8'
      )
    } catch {
      /* ignore */
    }
    const clickError = grab.error
    const winRead = readFromRawTimes(
      title,
      String(grab.infoName || '').trim(),
      String(grab.ocrText || ''),
      String(grab.rawLength || ''),
      String(grab.rawStart || ''),
      String(grab.rawEnd || ''),
      Boolean(grab.noObjectSelected),
      clickError
    )
    if (grab.noObjectSelected || !winRead.nameMatched) {
      return winRead
    }
    // Always Tesseract the 4–5× times strip when present. Windows OCR often
    // invents keepable-but-wrong lengths; the strip is the reliable source.
    const tessTimes = grab.timesPng ? await ocrDigits(grab.timesPng) : ''
    const tessLength = grab.lengthPng ? await ocrDigits(grab.lengthPng) : ''
    // Tesseract often glues Start/End/Length with no spaces, e.g.
    // "1:34:39.6601:38:31.2500:03:51.590". Break after .mmm when the next
    // time starts with a digit+colon (hour of the following field).
    let unglued = `${tessTimes} ${tessLength}`
    for (let i = 0; i < 4; i++) {
      unglued = unglued.replace(/(\.\d{3})(\d:\d{2}:\d{2})/g, '$1 $2')
    }
    const tokenRe =
      /(\d{1,2}:[0-5]\d:[0-5]\d(?:[.,]\d{1,4})?|\d{5,10}[.,]\d{1,4}|[0O]:\d{2}[:S]\d+[.,]?\d*)/gi
    const timeTokens: string[] = []
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(unglued))) {
      timeTokens.push(m[0])
    }
    // Prefer real H:MM:SS.mmm tokens over digit-only garbage (e.g. 020551.550 → false 2:05).
    const hmsTokens = timeTokens.filter((t) => /^\d{1,2}:[0-5]\d:[0-5]\d/.test(t))
    const useTokens = hmsTokens.length >= 1 ? hmsTokens : timeTokens
    try {
      fs.appendFileSync(
        path.join(tempWorkDir(), 'last-grab-log.txt'),
        `\ntessTimes=${tessTimes}\ntessLength=${tessLength}\nunglued=${unglued}\ntokens=${useTokens.join(' | ')}\n`,
        'utf8'
      )
    } catch {
      /* ignore */
    }
    if (useTokens.length >= 1) {
      let rawStart = ''
      let rawEnd = ''
      let rawLength = ''
      const secOf = (t: string): number | null => parseCubaseTimecode(t)
      const isAbs = (t: string): boolean => {
        const s = secOf(t)
        return s != null && s >= 15 * 60
      }
      const isLen = (t: string): boolean => {
        const s = secOf(t)
        return s != null && s >= 90 && s <= 12 * 60
      }
      if (useTokens.length >= 3) {
        rawStart = useTokens[0]!
        rawEnd = useTokens[1]!
        rawLength = useTokens[2]!
      } else if (useTokens.length === 2) {
        const a = useTokens[0]!
        const b = useTokens[1]!
        // Reach case: Start abs + Length short, End OCR mangled/dropped
        // (e.g. "1:17:04.250" + "0:04:12.450"). Do NOT treat as Start+End.
        if (isAbs(a) && isLen(b)) {
          rawStart = a
          rawLength = b
        } else if (isLen(a) && isAbs(b)) {
          rawLength = a
          rawStart = b
        } else {
          rawStart = a
          rawEnd = b
        }
      } else {
        rawLength = useTokens[0]!
      }
      // If any token is a clear song-length and Length unset, prefer it.
      if (!rawLength) {
        const lenTok = useTokens.find((t) => isLen(t))
        if (lenTok) rawLength = lenTok
      }
      // Reject absolute End-like "lengths" (>12 min) when span is available.
      const lenSec = secOf(rawLength)
      const spanSec =
        secOf(rawStart) != null && secOf(rawEnd) != null
          ? (secOf(rawEnd) as number) - (secOf(rawStart) as number)
          : null
      if (
        lenSec != null &&
        spanSec != null &&
        spanSec > 30 &&
        Math.abs(lenSec - spanSec) > 2.5 &&
        isSaneSongLengthSeconds(spanSec)
      ) {
        rawLength = ''
      }
      if (!rawLength && parseCubaseTimecode(tessLength) != null && /^\d{1,2}:/.test(tessLength)) {
        rawLength = tessLength
      }
      const tessRead = readFromRawTimes(
        title,
        String(grab.infoName || '').trim(),
        `${grab.ocrText || ''} ${unglued}`,
        rawLength,
        rawStart,
        rawEnd,
        Boolean(grab.noObjectSelected),
        clickError
      )
      if (isUsableLengthRead(tessRead, title)) {
        return tessRead
      }
    }
    if (isUsableLengthRead(winRead, title)) {
      return winRead
    }
    return readFromRawTimes(
      title,
      String(grab.infoName || '').trim(),
      `${grab.ocrText || ''} ${unglued}`,
      String(useTokens[2] || useTokens[useTokens.length - 1] || grab.rawLength || ''),
      String(grab.rawStart || useTokens[0] || ''),
      String(grab.rawEnd || useTokens[1] || ''),
      Boolean(grab.noObjectSelected),
      clickError
    )
  } catch (err) {
    return emptyRead(err instanceof Error ? err.message : String(err))
  }
}

export async function readCubaseArrangerLength(expectedTitle?: string): Promise<CubaseLengthRead> {
  return grabCubaseEventLength(expectedTitle || '')
}

export type ReadLengthOptions = {
  /** When true, allow one inspector-list click if Name missing / no object. Default true when auto-click on. */
  allowClick?: boolean
  /**
   * Called after a click so the host can MIDI-Stop if transport started.
   * Return true if length pass must abort (e.g. playback started).
   */
  onAfterClick?: () => boolean | Promise<boolean>
}

/**
 * Read Info Line Length only when Name matches (or fuzzy-matches) expectedTitle.
 * Never accepts length under "No Object Selected". Never blanks prior lengths (caller keeps them).
 */
export async function readCubaseLengthForEvent(
  eventName: string,
  _opts?: ReadLengthOptions
): Promise<CubaseLengthRead> {
  try {
    return await grabCubaseEventLength(eventName)
  } catch (err) {
    return emptyRead(err instanceof Error ? err.message : String(err))
  }
}

/** Select arranger event + zoom locators — prep for render capture (no playback). */
export async function cubaseRenderPrepare(eventName: string): Promise<CubaseLengthRead> {
  const title = eventName.trim()
  try {
    const outDir = tempWorkDir()
    const raw = await runPowershell(['renderprep', outDir, title], POWERSHELL_GRAB_TIMEOUT_MS)
    const grab = parseJsonLine<PsGrabResult>(raw)
    console.log(
      `[ViewerOne] Cubase render prep “${title}”: name="${String(grab.infoName || '').trim()}" ` +
        `len=${grab.rawLength || ''}`
    )
    return readFromRawTimes(
      title,
      String(grab.infoName || '').trim(),
      '',
      String(grab.rawLength || ''),
      String(grab.rawStart || ''),
      String(grab.rawEnd || ''),
      false,
      grab.error
    )
  } catch (err) {
    return emptyRead(err instanceof Error ? err.message : String(err))
  }
}

/** Send Cubase Stop via PowerShell helper (does not touch ViewerOne transport state). */
export async function cubasePsStop(): Promise<void> {
  try {
    await runPowershell(['stop', tempWorkDir(), ''], POWERSHELL_TIMEOUT_MS)
  } catch {
    /* best effort */
  }
}

/** Foreground Cubase and Space — actual transport Play (MIDI Start often does not roll ASIO/Stereo Mix). */
export async function cubasePsPlay(): Promise<void> {
  try {
    await runPowershell(['play', tempWorkDir(), ''], POWERSHELL_TIMEOUT_MS)
  } catch {
    /* best effort */
  }
}
