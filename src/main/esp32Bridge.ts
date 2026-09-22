import { SerialPort } from 'serialport'
import type { Esp32DisplayPayload } from '../shared/types.js'
import { ESP32_SERIAL_PORT_AUTO, pickEsp32UsbSerialPath, type Esp32UsbSerialListEntry } from '../shared/esp32Serial.js'
import { clampLedPatternId } from '../shared/ledPatterns.js'

export type { Esp32DisplayPayload } from '../shared/types.js'

let port: SerialPort | null = null
let openPath: string | null = null
let rxBuf = ''
/**
 * Ports dropped by a Windows USB yank. Calling `close()` on those handles can
 * native-crash Electron (`electron has stopped working`). Keep a few alive so
 * GC does not run the binding destructor on a dead COM port.
 */
const abandonedPorts: SerialPort[] = []
const MAX_ABANDONED_PORTS = 6

/** Concrete COM/tty path or {@link ESP32_SERIAL_PORT_AUTO} for list-based pick. */
let desiredPath: string | null = null
let onOpenedCb: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
/** Bumps when configuration changes or a reconnect attempt starts; invalidates in-flight async opens. */
let openGeneration = 0

export type Esp32FromDeviceMsg = Record<string, unknown>

export type Esp32LineHandler = (msg: Esp32FromDeviceMsg) => void

let lineHandler: Esp32LineHandler | null = null
let connectionHandler: ((connected: boolean, path: string | null) => void) | null = null

export function setEsp32LineHandler(handler: Esp32LineHandler | null): void {
  lineHandler = handler
}

export function setEsp32ConnectionHandler(
  handler: ((connected: boolean, path: string | null) => void) | null
): void {
  connectionHandler = handler
}

function notifyConnection(connected: boolean, path: string | null): void {
  try {
    connectionHandler?.(connected, path)
  } catch (err) {
    console.warn('[ViewerOne] ESP32 connection handler threw (swallowed):', err)
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function attachSerialReader(p: SerialPort): void {
  rxBuf = ''
  p.on('data', (chunk: Buffer) => {
    rxBuf += chunk.toString('utf8')
    for (;;) {
      const i = rxBuf.indexOf('\n')
      if (i < 0) break
      const line = rxBuf.slice(0, i).trim()
      rxBuf = rxBuf.slice(i + 1)
      if (!line || !lineHandler) continue
      try {
        const msg = JSON.parse(line) as Esp32FromDeviceMsg
        try {
          lineHandler(msg)
        } catch (err) {
          console.warn('[ViewerOne] ESP32 line handler threw (swallowed):', err)
        }
      } catch {
        /* ignore non-JSON noise */
      }
    }
  })
}

function detachPortListeners(p: SerialPort): void {
  try {
    p.removeAllListeners()
  } catch {
    /* ignore */
  }
}

/** Device vanished — do not close(); Windows serialport close() can kill Electron. */
function abandonPort(p: SerialPort): void {
  detachPortListeners(p)
  abandonedPorts.push(p)
  while (abandonedPorts.length > MAX_ABANDONED_PORTS) {
    abandonedPorts.shift()
  }
}

/** Host-initiated close only (settings off / quit). Never use after a USB yank. */
function closePortIfStillOpen(p: SerialPort, done?: () => void): void {
  try {
    if (!p.isOpen) {
      done?.()
      return
    }
    p.close((err) => {
      if (err) console.warn('[ViewerOne] ESP32 serial close:', err.message)
      done?.()
    })
  } catch {
    done?.()
  }
}

function dropLivePort(p: SerialPort, reason: string): void {
  if (port !== p) return
  console.warn('[ViewerOne] ESP32 serial disconnected:', openPath ?? desiredPath, reason)
  port = null
  openPath = null
  abandonPort(p)
  notifyConnection(false, null)
  if (desiredPath) scheduleReconnect(openGeneration, 1000)
}

function attachDisconnectHandlers(p: SerialPort): void {
  p.on('error', (err: Error & { message?: string }) => {
    console.warn('[ViewerOne] ESP32 serial error:', err?.message ?? err)
    dropLivePort(p, 'error')
  })
  p.on('close', () => dropLivePort(p, 'close'))
}

function disposeCurrentPort(): void {
  if (!port) return
  const p = port
  port = null
  openPath = null
  detachPortListeners(p)
  closePortIfStillOpen(p)
}

function disposeCurrentPortAsync(): Promise<void> {
  return new Promise((resolve) => {
    if (!port) {
      resolve()
      return
    }
    const p = port
    port = null
    openPath = null
    detachPortListeners(p)
    const timer = setTimeout(resolve, 600)
    closePortIfStillOpen(p, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function scheduleReconnect(prevGen: number, minDelayMs = 0): void {
  if (!desiredPath) return
  clearReconnectTimer()
  const exp = Math.min(reconnectAttempt, 5)
  const delayMs = Math.max(minDelayMs, Math.min(5000, 250 * 2 ** exp))
  reconnectAttempt = Math.min(reconnectAttempt + 1, 12)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (openGeneration !== prevGen) return
    openGeneration++
    void openDesiredPath()
  }, delayMs)
}

async function openDesiredPath(): Promise<void> {
  const gen = openGeneration
  if (!desiredPath) return
  if (desiredPath !== ESP32_SERIAL_PORT_AUTO && port?.isOpen && openPath === desiredPath) return
  if (desiredPath === ESP32_SERIAL_PORT_AUTO && port?.isOpen) return

  disposeCurrentPort()

  let concretePath: string | null = null
  if (desiredPath === ESP32_SERIAL_PORT_AUTO) {
    let list: Awaited<ReturnType<typeof SerialPort.list>>
    try {
      list = await SerialPort.list()
    } catch (err) {
      console.warn('[ViewerOne] ESP32 SerialPort.list failed:', err)
      if (desiredPath) scheduleReconnect(gen, 1000)
      return
    }
    if (gen !== openGeneration) return
    const entries: Esp32UsbSerialListEntry[] = list.map((portInfo) => ({
      path: portInfo.path,
      friendly: portInfo.friendlyName ?? undefined,
      manufacturer: portInfo.manufacturer ?? undefined,
      vendorId: portInfo.vendorId ?? undefined,
      productId: portInfo.productId ?? undefined
    }))
    concretePath = pickEsp32UsbSerialPath(entries)
    if (!concretePath) {
      console.warn(
        '[ViewerOne] ESP32 auto COM: no unambiguous port (plug the board, or pick COM manually if several USB-serial devices).'
      )
      if (desiredPath) scheduleReconnect(gen)
      return
    }
  } else {
    concretePath = desiredPath
  }

  if (gen !== openGeneration) return

  try {
    const p = new SerialPort({
      path: concretePath,
      baudRate: 115200,
      autoOpen: false,
      hupcl: false
    })
    p.open((err) => {
      if (gen !== openGeneration) {
        detachPortListeners(p)
        closePortIfStillOpen(p)
        return
      }
      if (err) {
        console.warn('[ViewerOne] ESP32 serial open failed:', concretePath, err.message)
        detachPortListeners(p)
        if (desiredPath) scheduleReconnect(gen)
        return
      }
      openPath = concretePath
      port = p
      reconnectAttempt = 0
      attachSerialReader(p)
      attachDisconnectHandlers(p)
      notifyConnection(true, concretePath)
      const mode = desiredPath === ESP32_SERIAL_PORT_AUTO ? ' (auto)' : ''
      console.log('[ViewerOne] ESP32 serial:', concretePath, '@ 115200' + mode)
      try {
        onOpenedCb?.()
      } catch (openedErr) {
        console.warn('[ViewerOne] ESP32 onOpened callback threw (swallowed):', openedErr)
      }
    })
  } catch (e) {
    console.warn('[ViewerOne] ESP32 serial:', e)
    if (desiredPath) scheduleReconnect(gen)
  }
}

/** Open COM port for ESP32 (USB CDC). Pass null to disable. `onOpened` runs after a successful open (including auto-reconnect). */
export function setEsp32SerialPort(path: string | null, onOpened?: () => void): void {
  clearReconnectTimer()
  if (!path) {
    openGeneration++
    desiredPath = null
    onOpenedCb = null
    reconnectAttempt = 0
    disposeCurrentPort()
    notifyConnection(false, null)
    return
  }
  if (path === desiredPath && port?.isOpen) return

  openGeneration++
  desiredPath = path
  onOpenedCb = onOpened ?? null
  reconnectAttempt = 0
  disposeCurrentPort()
  void openDesiredPath()
}

/** Write a line; never throw. On failure, drop the port and schedule reconnect. */
function writeSerialLine(line: string, label: string): void {
  const p = port
  if (!p?.isOpen) return
  try {
    p.write(line, (err) => {
      if (!err) return
      console.warn(`[ViewerOne] ESP32 ${label} write:`, err.message)
      dropLivePort(p, 'write')
    })
  } catch (e) {
    console.warn(`[ViewerOne] ESP32 ${label} write threw:`, e)
    dropLivePort(p, 'write-throw')
  }
}

export function pushEsp32Payload(payload: Esp32DisplayPayload): void {
  writeSerialLine(JSON.stringify(payload) + '\n', 'serial')
}

/** Ask current firmware to announce its model and physical display resolution. */
export function pushEsp32HelloRequest(): void {
  writeSerialLine('{"cmd":"hello"}\n', 'hello')
}

/** Trigger an LED pattern on the merged ViewerOne firmware (`{"led":"pattern","id":N}`). */
export function pushEsp32LedPattern(patternId: number): void {
  const id = clampLedPatternId(patternId)
  writeSerialLine(JSON.stringify({ led: 'pattern', id }) + '\n', 'LED')
}

/** Set LED brightness on the ESP (`{"led":"brightness","v":N}`). */
export function pushEsp32LedBrightness(brightness: number): void {
  const v = Math.max(0, Math.min(255, Math.trunc(brightness)))
  writeSerialLine(JSON.stringify({ led: 'brightness', v }) + '\n', 'brightness')
}

/** Set one CrowPanel prompt indicator; CYD firmware safely ignores this standalone JSON. */
export function pushEsp32Prompt(prompt: 1 | 2, on: boolean): void {
  writeSerialLine(JSON.stringify({ prompt, on }) + '\n', `prompt ${prompt}`)
}

/** Host wall clock HH:MM for CrowPanel brand bar (ESP has no reliable RTC). */
export function pushEsp32Clock(hm: string): void {
  const t = (hm ?? '').trim()
  if (!/^\d{2}:\d{2}$/.test(t)) return
  writeSerialLine(JSON.stringify({ hm: t }) + '\n', 'clock')
}

export function shutdownEsp32Serial(): void {
  clearReconnectTimer()
  openGeneration++
  desiredPath = null
  onOpenedCb = null
  reconnectAttempt = 0
  disposeCurrentPort()
  notifyConnection(false, null)
}

/** Wait for the COM port close callback so native serialport is not torn down mid-close. */
export function shutdownEsp32SerialAsync(): Promise<void> {
  clearReconnectTimer()
  openGeneration++
  desiredPath = null
  onOpenedCb = null
  reconnectAttempt = 0
  return disposeCurrentPortAsync().then(() => notifyConnection(false, null))
}
