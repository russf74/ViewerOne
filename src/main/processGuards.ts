/**
 * Production hardening for Electron main on Windows:
 * console.log → stdout can throw EPIPE when no console / parent closed the pipe.
 * That used to kill the whole app mid-gig (uncaught from MIDI easymidi handlers).
 */

const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'])

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  if (e.code && BROKEN_PIPE_CODES.has(e.code)) return true
  if (typeof e.message === 'string' && /broken pipe|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED/i.test(e.message)) {
    return true
  }
  return false
}

/** MIDI / serial IO failures that must never take down the process. */
export function isRecoverableIoError(err: unknown): boolean {
  if (isBrokenPipeError(err)) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string; name?: string }
  const msg = typeof e.message === 'string' ? e.message : ''
  if (/midi|serial|port.*(closed|not open|ENOENT|EBUSY)/i.test(msg)) return true
  if (e.code === 'ENOENT' || e.code === 'EBUSY' || e.code === 'EIO') return true
  return false
}

function safeStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    /* ignore — even stderr may be a broken pipe */
  }
}

function wrapConsoleMethod(
  method: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    try {
      method(...args)
    } catch (err) {
      if (isBrokenPipeError(err)) return
      safeStderr(`[ViewerOne] console write failed: ${String(err)}`)
    }
  }
}

let installed = false

/** Call once at the very top of main before any MIDI/serial/console use. */
export function installProcessGuards(): void {
  if (installed) return
  installed = true

  console.log = wrapConsoleMethod(console.log.bind(console)) as typeof console.log
  console.info = wrapConsoleMethod(console.info.bind(console)) as typeof console.info
  console.warn = wrapConsoleMethod(console.warn.bind(console)) as typeof console.warn
  console.error = wrapConsoleMethod(console.error.bind(console)) as typeof console.error
  console.debug = wrapConsoleMethod(console.debug.bind(console)) as typeof console.debug

  process.on('uncaughtException', (err) => {
    if (isBrokenPipeError(err) || isRecoverableIoError(err)) {
      safeStderr(`[ViewerOne] ignored recoverable uncaughtException: ${err?.message ?? err}`)
      return
    }
    safeStderr(`[ViewerOne] uncaughtException (kept alive): ${err?.stack ?? err}`)
  })

  process.on('unhandledRejection', (reason) => {
    if (isBrokenPipeError(reason) || isRecoverableIoError(reason)) {
      safeStderr(`[ViewerOne] ignored recoverable unhandledRejection: ${String(reason)}`)
      return
    }
    safeStderr(`[ViewerOne] unhandledRejection (kept alive): ${String(reason)}`)
  })

  // Prevent Node from exiting when stdout/stderr emit error (broken pipe).
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (err: Error) => {
      if (isBrokenPipeError(err)) return
      safeStderr(`[ViewerOne] stdio stream error: ${err.message}`)
    })
  }
}
