/** Internal mode: pick a port from `SerialPort.list()` (CH340 / USB-serial heuristics). */
export const ESP32_SERIAL_PORT_AUTO = '__AUTO__' as const

export type Esp32UsbSerialListEntry = {
  path: string
  friendly?: string
  manufacturer?: string
}

/** Score USB UART bridges common on ESP32 boards; higher = stronger match. */
function usbSerialHeuristicScore(p: Esp32UsbSerialListEntry): number {
  const label = `${p.friendly ?? ''} ${p.manufacturer ?? ''}`.toUpperCase()
  let s = 0
  if (label.includes('CH340') || label.includes('CH341') || label.includes('CH910')) s = Math.max(s, 3)
  if (label.includes('CP210') || label.includes('SILICON LABS')) s = Math.max(s, 2)
  if (label.includes('USB-SERIAL')) s = Math.max(s, 1)
  return s
}

/**
 * Pick one COM/device path for the ESP display.
 * - Prefer a single strong USB-serial match (CH340, USB-SERIAL, etc.).
 * - If none match but exactly one port exists, use it (single-device setups).
 * - If several match or none match with multiple ports, return null (caller should retry or ask user).
 */
export function pickEsp32UsbSerialPath(ports: Esp32UsbSerialListEntry[]): string | null {
  if (ports.length === 0) return null
  const matches = ports.filter((p) => usbSerialHeuristicScore(p) >= 1)
  if (matches.length === 1) return matches[0].path
  if (matches.length > 1) return null
  if (ports.length === 1) return ports[0].path
  return null
}
