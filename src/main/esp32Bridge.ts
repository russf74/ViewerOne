import { SerialPort } from 'serialport'
import type { Esp32DisplayPayload } from '../shared/types.js'

export type { Esp32DisplayPayload } from '../shared/types.js'

let port: SerialPort | null = null
let openPath: string | null = null
let rxBuf = ''

/** Path the user asked for; kept across unplug so we can reopen. */
let desiredPath: string | null = null
let onOpenedCb: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** Increments on each failed open / disconnect; reset when a port stays open. */
let reconnectAttempt = 0

export type Esp32FromDeviceMsg = Record<string, unknown>

/** Lines from ESP32 (touch, etc.); parse errors ignored. */
export type Esp32LineHandler = (msg: Esp32FromDeviceMsg) => void

let lineHandler: Esp32LineHandler | null = null

export function setEsp32LineHandler(handler: Esp32LineHandler | null): void {
  lineHandler = handler
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
        lineHandler(JSON.parse(line) as Esp32FromDeviceMsg)
      } catch {
        /* ignore non-JSON noise */
      }
    }
  })
}

function attachDisconnectHandlers(p: SerialPort): void {
  const onDrop = () => {
    if (port !== p) return
    console.warn('[ViewerOne] ESP32 serial disconnected:', openPath ?? desiredPath)
    disposeCurrentPort()
    if (desiredPath) scheduleReconnect()
  }
  p.on('error', (err: Error & { message?: string }) => {
    console.warn('[ViewerOne] ESP32 serial error:', err?.message ?? err)
    onDrop()
  })
  p.on('close', onDrop)
}

export async function listSerialPorts(): Promise<{ path: string; friendly?: string }[]> {
  const list = await SerialPort.list()
  return list.map((portInfo) => ({
    path: portInfo.path,
    friendly: portInfo.friendlyName ?? portInfo.manufacturer ?? undefined
  }))
}

function disposeCurrentPort(): void {
  if (!port) return
  try {
    port.removeAllListeners()
    if (port.isOpen) port.close()
  } catch {
    /* ignore */
  }
  port = null
  openPath = null
}

/** Backoff so unplug/replug is snappy without tight spin when the device is absent. */
function scheduleReconnect(): void {
  if (!desiredPath) return
  clearReconnectTimer()
  const exp = Math.min(reconnectAttempt, 5)
  const delayMs = Math.min(5000, 250 * 2 ** exp)
  reconnectAttempt = Math.min(reconnectAttempt + 1, 12)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openDesiredPath()
  }, delayMs)
}

function openDesiredPath(): void {
  if (!desiredPath) return
  if (port?.isOpen && openPath === desiredPath) return

  disposeCurrentPort()

  try {
    const p = new SerialPort({
      path: desiredPath,
      baudRate: 115200,
      autoOpen: false
    })
    p.open((err) => {
      if (err) {
        console.warn('[ViewerOne] ESP32 serial open failed:', desiredPath, err.message)
        disposeCurrentPort()
        if (desiredPath) scheduleReconnect()
        return
      }
      openPath = desiredPath
      port = p
      reconnectAttempt = 0
      attachSerialReader(p)
      attachDisconnectHandlers(p)
      console.log('[ViewerOne] ESP32 serial:', desiredPath, '@ 115200')
      onOpenedCb?.()
    })
  } catch (e) {
    console.warn('[ViewerOne] ESP32 serial:', e)
    if (desiredPath) scheduleReconnect()
  }
}

/** Open COM port for ESP32 (USB CDC). Pass null to disable. `onOpened` runs after a successful open (including auto-reconnect). */
export function setEsp32SerialPort(path: string | null, onOpened?: () => void): void {
  clearReconnectTimer()
  if (!path) {
    desiredPath = null
    onOpenedCb = null
    reconnectAttempt = 0
    disposeCurrentPort()
    return
  }
  if (path === openPath && port?.isOpen && path === desiredPath) return

  desiredPath = path
  onOpenedCb = onOpened ?? null
  reconnectAttempt = 0
  disposeCurrentPort()
  openDesiredPath()
}

export function pushEsp32Payload(payload: Esp32DisplayPayload): void {
  if (!port?.isOpen) return
  const line = JSON.stringify(payload) + '\n'
  port.write(line, (err) => {
    if (err) console.warn('[ViewerOne] ESP32 serial write:', err.message)
  })
}

export function shutdownEsp32Serial(): void {
  clearReconnectTimer()
  desiredPath = null
  onOpenedCb = null
  reconnectAttempt = 0
  disposeCurrentPort()
}
