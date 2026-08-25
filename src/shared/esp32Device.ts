import type { Esp32DeviceType, Esp32DisplayStatus } from './types.js'

export const CYD_DISPLAY = {
  device: 'cyd' as const,
  model: 'ESP32-2432S028R',
  width: 320,
  height: 240
}

export const CROWPANEL_7_DISPLAY = {
  device: 'crowpanel7' as const,
  model: 'Elecrow CrowPanel Advanced 7',
  width: 1024,
  height: 600
}

/** Use CrowPanel for simulation unless hardware positively identifies as CYD. */
export function getEsp32PreviewDisplay(status: Esp32DisplayStatus) {
  return status.device === 'cyd' ? CYD_DISPLAY : CROWPANEL_7_DISPLAY
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function normalizeDevice(value: unknown, width: number | null, height: number | null): Esp32DeviceType {
  const id = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]/g, '') : ''
  if (id === 'cyd' || id === 'esp322432s028r' || id === 'ili9341') return 'cyd'
  if (
    id === 'crowpanel7' ||
    id === 'crowpanel7p4' ||
    id === 'crowpaneladvanced7' ||
    id === 'elecrowcrowpanel7'
  ) {
    return 'crowpanel7'
  }
  if (width === 320 && height === 240) return 'cyd'
  if (width === 1024 && height === 600) return 'crowpanel7'
  return 'unknown'
}

/** Parse identity fields from an `evt: hello`, `evt: boot`, or `evt: device` JSON line. */
export function parseEsp32DisplayIdentity(msg: Record<string, unknown>): Esp32DisplayStatus | null {
  const evt = msg['evt']
  if (evt !== 'hello' && evt !== 'boot' && evt !== 'device') return null

  const width = positiveInt(msg['w'] ?? msg['width'])
  const height = positiveInt(msg['h'] ?? msg['height'])
  const device = normalizeDevice(msg['device'] ?? msg['type'] ?? msg['board'], width, height)
  if (device === 'unknown' && width === null && height === null && typeof msg['model'] !== 'string') return null

  const known = device === 'cyd' ? CYD_DISPLAY : device === 'crowpanel7' ? CROWPANEL_7_DISPLAY : null
  const model =
    typeof msg['model'] === 'string' && msg['model'].trim()
      ? msg['model'].trim()
      : known?.model ?? null

  const fw =
    typeof msg['fw'] === 'string' && msg['fw'].trim()
      ? msg['fw'].trim()
      : typeof msg['firmware'] === 'string' && msg['firmware'].trim()
        ? msg['firmware'].trim()
        : null

  return {
    connection: 'connected',
    device,
    model,
    width: width ?? known?.width ?? null,
    height: height ?? known?.height ?? null,
    fw
  }
}
