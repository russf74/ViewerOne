import { SerialPort } from 'serialport'
import {
  pickDmxisUsbSerialPath,
  DMX_SEND_CHANNELS,
  type DmxConnection,
  type DmxStatus,
  type UsbSerialListEntry
} from '../shared/dmx.js'

const USB_PRO_BAUD = 57600
const USB_PRO_START = 0x7e
const USB_PRO_END = 0xe7
const USB_PRO_LABEL_GET_PARAMS = 3
const USB_PRO_LABEL_SEND_DMX = 6
/** Widget drops DMX if it goes ~1s without a packet. */
const KEEPALIVE_MS = 250

let port: SerialPort | null = null
let openPath: string | null = null
let enabled = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let openGeneration = 0
let opening = false
let universe = Buffer.alloc(512, 0)
const dmxPayload = Buffer.alloc(1 + DMX_SEND_CHANNELS)
let writeBusy = false
let writeQueued = false
let connectionHandler: ((status: DmxStatus) => void) | null = null
let lastStatus: DmxStatus = { connection: 'disabled', path: null }

export function setDmxConnectionHandler(handler: ((status: DmxStatus) => void) | null): void {
  connectionHandler = handler
}

export function getDmxStatus(): DmxStatus {
  return lastStatus
}

function notify(connection: DmxConnection, path: string | null): void {
  lastStatus = { connection, path }
  try {
    connectionHandler?.(lastStatus)
  } catch (err) {
    console.warn('[ViewerOne] DMX connection handler threw (swallowed):', err)
  }
}

function usbProPacket(label: number, data: Buffer): Buffer {
  const packet = Buffer.alloc(5 + data.length)
  packet[0] = USB_PRO_START
  packet[1] = label
  packet[2] = data.length & 0xff
  packet[3] = (data.length >> 8) & 0xff
  data.copy(packet, 4)
  packet[4 + data.length] = USB_PRO_END
  return packet
}

function sendDmxPacket(): void {
  const p = port
  if (!p?.isOpen) return
  if (writeBusy) {
    writeQueued = true
    return
  }
  dmxPayload[0] = 0
  universe.copy(dmxPayload, 1, 0, DMX_SEND_CHANNELS)
  writeBusy = true
  p.write(usbProPacket(USB_PRO_LABEL_SEND_DMX, dmxPayload), (err) => {
    writeBusy = false
    if (err) {
      console.warn('[ViewerOne] DMX write failed:', err.message)
    }
    if (writeQueued) {
      writeQueued = false
      sendDmxPacket()
    }
  })
}

function startKeepalive(): void {
  stopKeepalive()
  keepaliveTimer = setInterval(() => sendDmxPacket(), KEEPALIVE_MS)
  keepaliveTimer.unref()
  sendDmxPacket()
}

function stopKeepalive(): void {
  if (!keepaliveTimer) return
  clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function closePort(p: SerialPort): Promise<void> {
  return new Promise((resolve) => {
    if (!p.isOpen) {
      resolve()
      return
    }
    p.close((err) => {
      if (err) console.warn('[ViewerOne] DMXIS close:', err.message)
      resolve()
    })
  })
}

async function disposeCurrentPort(): Promise<void> {
  stopKeepalive()
  writeBusy = false
  writeQueued = false
  const p = port
  port = null
  openPath = null
  if (!p) return
  p.removeAllListeners()
  await closePort(p)
}

function scheduleReconnect(prevGen: number): void {
  if (!enabled) return
  clearReconnectTimer()
  const exp = Math.min(reconnectAttempt, 5)
  const delayMs = Math.min(5000, 400 * 2 ** exp)
  reconnectAttempt = Math.min(reconnectAttempt + 1, 12)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (openGeneration !== prevGen) return
    openGeneration++
    void openDmxisPort()
  }, delayMs)
}

async function openDmxisPort(): Promise<void> {
  const gen = openGeneration
  if (!enabled || opening) return
  if (port?.isOpen) return

  opening = true
  try {
    await disposeCurrentPort()
    if (gen !== openGeneration || !enabled) return
    notify('searching', null)

    let list: Awaited<ReturnType<typeof SerialPort.list>>
    try {
      list = await SerialPort.list()
    } catch (err) {
      console.warn('[ViewerOne] DMX SerialPort.list failed:', err)
      if (enabled) scheduleReconnect(gen)
      return
    }
    if (gen !== openGeneration) return

    const entries: UsbSerialListEntry[] = list.map((info) => ({
      path: info.path,
      friendly: info.friendlyName ?? undefined,
      manufacturer: info.manufacturer ?? undefined,
      vendorId: info.vendorId ?? undefined,
      productId: info.productId ?? undefined
    }))
    const concretePath = pickDmxisUsbSerialPath(entries)
    if (!concretePath) {
      console.warn('[ViewerOne] DMXIS: no FTDI COM port (plug the widget; close Enttec DMXIS software).')
      if (enabled) scheduleReconnect(gen)
      return
    }

    const p = new SerialPort({
      path: concretePath,
      baudRate: USB_PRO_BAUD,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      hupcl: false,
      autoOpen: false
    })

    await new Promise<void>((resolve) => {
      p.open((err) => {
        void (async () => {
          if (gen !== openGeneration) {
            p.removeAllListeners()
            await closePort(p)
            resolve()
            return
          }
          if (err) {
            console.warn(
              '[ViewerOne] DMXIS open failed:',
              concretePath,
              err.message,
              '— close Enttec DMXIS / Cubase DMXIS VST, then toggle Enable DMXIS'
            )
            if (enabled) scheduleReconnect(gen)
            resolve()
            return
          }
          try {
            p.set({ dtr: false, rts: false })
          } catch {
            /* optional on some bindings */
          }
          openPath = concretePath
          port = p
          reconnectAttempt = 0
          p.on('error', (e: Error) => {
            console.warn('[ViewerOne] DMXIS serial error:', e.message)
            if (port !== p) return
            port = null
            openPath = null
            stopKeepalive()
            notify('searching', null)
            if (enabled) scheduleReconnect(gen)
            void closePort(p)
          })
          p.on('close', () => {
            if (port !== p) return
            console.warn('[ViewerOne] DMXIS disconnected:', concretePath)
            port = null
            openPath = null
            stopKeepalive()
            notify('searching', null)
            if (enabled) scheduleReconnect(gen)
          })
          p.write(usbProPacket(USB_PRO_LABEL_GET_PARAMS, Buffer.from([0, 0])))
          startKeepalive()
          notify('connected', concretePath)
          console.log('[ViewerOne] DMXIS serial:', concretePath, '@ 57600 (Enttec USB Pro)')
          resolve()
        })()
      })
    })
  } catch (e) {
    console.warn('[ViewerOne] DMXIS serial:', e)
    if (enabled) scheduleReconnect(gen)
  } finally {
    opening = false
  }
}

/** Open or close the DMXIS COM port. Universe is unchanged (caller sets channels / blackout). */
export function setDmxEnabled(next: boolean): void {
  if (!next) {
    clearReconnectTimer()
    openGeneration++
    enabled = false
    reconnectAttempt = 0
    universe.fill(0)
    if (port?.isOpen) sendDmxPacket()
    void disposeCurrentPort().then(() => notify('disabled', null))
    return
  }
  if (enabled) return
  clearReconnectTimer()
  enabled = true
  openGeneration++
  reconnectAttempt = 0
  notify('searching', null)
  void openDmxisPort()
}

export function dmxBlackout(): void {
  universe.fill(0)
  sendDmxPacket()
}

export function dmxSetChannels(channels: { channel: number; value: number }[]): void {
  universe.fill(0)
  for (const { channel, value } of channels) {
    if (channel < 1 || channel > 512) continue
    universe[channel - 1] = Math.max(0, Math.min(255, Math.round(value)))
  }
  sendDmxPacket()
}

export function shutdownDmxSerial(): void {
  setDmxEnabled(false)
}

export function shutdownDmxSerialAsync(): Promise<void> {
  clearReconnectTimer()
  openGeneration++
  enabled = false
  reconnectAttempt = 0
  universe.fill(0)
  return disposeCurrentPort().then(() => notify('disabled', null))
}
