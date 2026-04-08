import { SerialPort } from 'serialport'
import type { Esp32DisplayPayload } from '../shared/types.js'

export type { Esp32DisplayPayload } from '../shared/types.js'

let port: SerialPort | null = null
let openPath: string | null = null

export async function listSerialPorts(): Promise<{ path: string; friendly?: string }[]> {
  const list = await SerialPort.list()
  return list.map((p) => ({
    path: p.path,
    friendly: p.friendlyName ?? p.manufacturer ?? undefined
  }))
}

function closePort(): void {
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

/** Open COM port for ESP32 (USB CDC). Pass null to disable. `onOpened` runs after a successful open. */
export function setEsp32SerialPort(path: string | null, onOpened?: () => void): void {
  if (path === openPath && port?.isOpen) return
  closePort()
  if (!path) return
  try {
    const p = new SerialPort({
      path,
      baudRate: 115200,
      autoOpen: false
    })
    p.open((err) => {
      if (err) {
        console.warn('[ViewerOne] ESP32 serial open failed:', path, err.message)
        closePort()
        return
      }
      openPath = path
      port = p
      console.log('[ViewerOne] ESP32 serial:', path, '@ 115200')
      onOpened?.()
    })
  } catch (e) {
    console.warn('[ViewerOne] ESP32 serial:', e)
  }
}

export function pushEsp32Payload(payload: Esp32DisplayPayload): void {
  if (!port?.isOpen) return
  const line = JSON.stringify(payload) + '\n'
  port.write(line, (err) => {
    if (err) console.warn('[ViewerOne] ESP32 serial write:', err.message)
  })
}

export function shutdownEsp32Serial(): void {
  closePort()
}
