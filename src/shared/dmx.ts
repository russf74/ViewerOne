import { clampLedPatternId } from './ledPatterns.js'
import { renderStickPixels, type Rgb } from './stickPixels.js'

/** Two cheap PAR-style fixtures: one DMX channel each, on / off / sound-active. */

export type DmxFixtureMode = 'off' | 'on' | 'sound'

export type DmxConnection = 'disabled' | 'searching' | 'connected'

export type DmxStatus = {
  connection: DmxConnection
  path: string | null
}

export const DMX_CHANNEL_MIN = 1
export const DMX_CHANNEL_MAX = 512
export const DMX_VALUE_OFF = 0
export const DMX_VALUE_ON = 255
/** Typical cheap PAR “sound active” band when this ID is a mode channel, not a dimmer. */
export const DMX_VALUE_SOUND = 140

/**
 * Hard-coded rig:
 * Freedom Stick **48-CH** pixel map @ 97–144 (not 8-CH autos — those are slow/dull).
 * PowerDome 10-CH @ 1–10. Sticks must be set to 48CH, address d097.
 */
export const DMX_FREEDOM_STICK_START = 97
export const DMX_POWERDOME_START = 1
/** 16 RGB cells → 48 channels (97–144). */
export const DMX_FREEDOM_STICK_CHANNELS = 48
/** Highest channel we drive; USB Pro packet is this long, not 512. */
export const DMX_SEND_CHANNELS = DMX_FREEDOM_STICK_START + DMX_FREEDOM_STICK_CHANNELS - 1
/** Match CrowPanel `kRandomRotateMs` — host rotates DMX with LED pattern 20. */
export const DMX_RANDOM_ROTATE_MS = 10000
/** Host-driven stick animation (Enttec USB Pro keepalive is 250ms; this is faster). */
export const DMX_STICK_FRAME_MS = 40

export type UsbSerialListEntry = {
  path: string
  friendly?: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

export function clampDmxChannel(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const n = Number.isFinite(parsed) ? Math.round(parsed) : fallback
  return Math.max(DMX_CHANNEL_MIN, Math.min(DMX_CHANNEL_MAX, n))
}

export function normalizeDmxFixtureMode(value: unknown, fallback: DmxFixtureMode = 'off'): DmxFixtureMode {
  return value === 'on' || value === 'sound' || value === 'off' ? value : fallback
}

export function dmxValueForMode(mode: DmxFixtureMode): number {
  if (mode === 'on') return DMX_VALUE_ON
  if (mode === 'sound') return DMX_VALUE_SOUND
  return DMX_VALUE_OFF
}

export type DmxLook = 'off' | 'idle' | 'live'

type DmxChannelValue = { channel: number; value: number }

function setRel(start: number, offset: number, value: number): DmxChannelValue | null {
  const channel = start + offset
  if (channel < 1 || channel > 512) return null
  return { channel, value: Math.max(0, Math.min(255, Math.round(value))) }
}

function pack(channels: (DmxChannelValue | null)[]): DmxChannelValue[] {
  return channels.filter((c): c is DmxChannelValue => c !== null)
}

/** PowerDome 10-CH auto 1–5 → CH8 midpoint. */
function domeAutoCh(program: number): number {
  const mids = [18, 43, 73, 93, 118]
  const n = Math.max(1, Math.min(5, Math.round(program)))
  return mids[n - 1]
}

type DomeCue = {
  dimmer: number
  r: number
  g: number
  b: number
  w: number
  /** 0/128 = stop; 1–127 fwd; 129–255 back. */
  rotate: number
  /** 0 = RGBW mode; 1–5 = auto show. */
  auto: number
  autoSpeed: number
}

function encodeStick48(start: number, pixels: Rgb[]): DmxChannelValue[] {
  const out: (DmxChannelValue | null)[] = []
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]
    out.push(setRel(start, i * 3, p[0]), setRel(start, i * 3 + 1, p[1]), setRel(start, i * 3 + 2, p[2]))
  }
  return pack(out)
}

function encodeDome(start: number, cue: DomeCue): DmxChannelValue[] {
  const auto = cue.auto > 0 ? domeAutoCh(cue.auto) : 0
  return pack([
    setRel(start, 0, cue.dimmer),
    setRel(start, 1, cue.auto > 0 ? 0 : cue.r),
    setRel(start, 2, cue.auto > 0 ? 0 : cue.g),
    setRel(start, 3, cue.auto > 0 ? 0 : cue.b),
    setRel(start, 4, cue.auto > 0 ? 0 : cue.w),
    setRel(start, 5, 0),
    setRel(start, 6, cue.rotate),
    setRel(start, 7, auto),
    setRel(start, 8, cue.auto > 0 ? cue.autoSpeed : 0),
    setRel(start, 9, 0)
  ])
}

const IDLE_DOME: DomeCue = {
  dimmer: 36,
  r: 25,
  g: 40,
  b: 255,
  w: 0,
  rotate: 16,
  auto: 0,
  autoSpeed: 0
}

/** One parked dome cue per ESP LED pattern id 0–21. Sticks are animated in 48-CH. */
const LED_DOME_CUES: Record<number, DomeCue> = {
  0: IDLE_DOME,
  1: { dimmer: 255, r: 20, g: 180, b: 90, w: 40, rotate: 55, auto: 0, autoSpeed: 0 },
  2: { dimmer: 255, r: 255, g: 0, b: 180, w: 40, rotate: 175, auto: 0, autoSpeed: 0 },
  3: { dimmer: 255, r: 0, g: 40, b: 255, w: 80, rotate: 70, auto: 0, autoSpeed: 0 },
  4: { dimmer: 255, r: 255, g: 30, b: 0, w: 50, rotate: 185, auto: 0, autoSpeed: 0 },
  5: { dimmer: 220, r: 40, g: 60, b: 180, w: 255, rotate: 48, auto: 0, autoSpeed: 0 },
  6: { dimmer: 255, r: 0, g: 255, b: 30, w: 40, rotate: 210, auto: 0, autoSpeed: 0 },
  7: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 110, auto: 5, autoSpeed: 255 },
  8: { dimmer: 255, r: 255, g: 0, b: 200, w: 30, rotate: 160, auto: 0, autoSpeed: 0 },
  9: { dimmer: 255, r: 60, g: 0, b: 255, w: 20, rotate: 95, auto: 0, autoSpeed: 0 },
  10: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 215, auto: 4, autoSpeed: 255 },
  11: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 115, auto: 5, autoSpeed: 255 },
  12: { dimmer: 255, r: 0, g: 255, b: 200, w: 80, rotate: 200, auto: 0, autoSpeed: 0 },
  13: { dimmer: 255, r: 255, g: 0, b: 30, w: 0, rotate: 58, auto: 0, autoSpeed: 0 },
  14: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 180, auto: 2, autoSpeed: 240 },
  15: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 122, auto: 1, autoSpeed: 255 },
  16: { dimmer: 255, r: 255, g: 0, b: 255, w: 80, rotate: 210, auto: 0, autoSpeed: 0 },
  17: { dimmer: 255, r: 255, g: 160, b: 0, w: 200, rotate: 78, auto: 0, autoSpeed: 0 },
  18: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 168, auto: 5, autoSpeed: 240 },
  19: { dimmer: 255, r: 255, g: 60, b: 0, w: 40, rotate: 118, auto: 0, autoSpeed: 0 },
  20: { dimmer: 255, r: 0, g: 0, b: 0, w: 0, rotate: 100, auto: 5, autoSpeed: 230 },
  21: { dimmer: 55, r: 0, g: 30, b: 160, w: 20, rotate: 14, auto: 0, autoSpeed: 0 }
}

export function powerDome10ChChannels(start: number, look: DmxLook): DmxChannelValue[] {
  if (look === 'off') return []
  return encodeDome(start, IDLE_DOME)
}

/** Random LED (20) → 1–19 from arranger index / program so each song differs. */
export function resolveDmxLedPattern(patternId: number, songSalt = 1): number {
  const id = clampLedPatternId(patternId)
  if (id === 99) return 99
  if (id === 20) return ((Math.max(1, Math.round(songSalt)) - 1) % 19) + 1
  return id
}

function partyPatternId(id: number, offset: number): number {
  const n = clampLedPatternId(id)
  if (n === 99) return 99
  if (n === 0 || n === 21) return offset % 2 === 0 ? 5 : 17
  const base = n === 20 ? 7 : n
  return ((base - 1 + offset) % 19) + 1
}

/** Freedom Sticks — different motion/palette than the ESP strip. */
export function complementaryStickPatternId(espPatternId: number): number {
  return partyPatternId(espPatternId, 7)
}

/** Spinning PowerDome — complementary colour/spin to ESP + sticks. */
export function complementaryDomePatternId(espPatternId: number): number {
  return partyPatternId(espPatternId, 12)
}

export function dmxUniverseForLedPattern(
  patternId: number,
  tMs = 0,
  stickBrightness = 1,
  opts?: { stickPatternId?: number; domePatternId?: number }
): DmxChannelValue[] {
  if (patternId === 99) return []
  const stickId = clampLedPatternId(opts?.stickPatternId ?? complementaryStickPatternId(patternId))
  const domeId = clampLedPatternId(opts?.domePatternId ?? complementaryDomePatternId(patternId))
  const dome = LED_DOME_CUES[domeId] ?? LED_DOME_CUES[7]
  return [
    ...encodeStick48(DMX_FREEDOM_STICK_START, renderStickPixels(stickId, tMs, stickBrightness)),
    ...encodeDome(DMX_POWERDOME_START, dome)
  ]
}

export function dmxUniverseForLook(look: DmxLook, tMs = 0): DmxChannelValue[] {
  if (look === 'off') return []
  return dmxUniverseForLedPattern(0, tMs, 0.2)
}

/** FTDI 0403:* (DMXIS / Enttec USB Pro) — never treat as the CrowPanel CH340. */
export function isFtdiUsbSerial(p: UsbSerialListEntry): boolean {
  const vid = (p.vendorId ?? '').replace(/^0x/i, '').toLowerCase()
  if (vid === '0403') return true
  const label = `${p.friendly ?? ''} ${p.manufacturer ?? ''}`.toUpperCase()
  return label.includes('FTDI')
}

/**
 * Pick the DMXIS / Enttec USB Pro COM port.
 * Prefers FTDI 0403:6001 and never returns `excludePath` (the ESP COM).
 */
export function pickDmxisUsbSerialPath(
  ports: UsbSerialListEntry[],
  excludePath?: string | null
): string | null {
  const ftdi = ports.filter((p) => isFtdiUsbSerial(p) && p.path !== excludePath)
  if (ftdi.length === 0) return null
  const pro = ftdi.filter((p) => (p.productId ?? '').replace(/^0x/i, '').toLowerCase() === '6001')
  if (pro.length === 1) return pro[0].path
  if (ftdi.length === 1) return ftdi[0].path
  if (pro.length > 1) return pro[0].path
  return ftdi[0].path
}
