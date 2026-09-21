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
 * PowerDome 10-CH @ 1–10.
 * Betopper LF4808 15-CH strobes @ 11–25 (not 152-CH pixels — that overlaps the sticks).
 * Freedom Stick **48-CH** pixel map @ 97–144 (not 8-CH autos — those are slow/dull).
 * Sticks: 48CH / d097. Strobes: 15CH / d011.
 */
export const DMX_FREEDOM_STICK_START = 97
export const DMX_POWERDOME_START = 1
export const DMX_STROBE_START = 11
/** 16 RGB cells → 48 channels (97–144). */
export const DMX_FREEDOM_STICK_CHANNELS = 48
/** LF4808 15-CH: dimmer, RGBW, macros, shutter. */
export const DMX_STROBE_CHANNELS = 15
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

type StrobeCue = {
  dimmer: number
  r: number
  g: number
  b: number
  w: number
  /** CH6 pigment — 0 lets RGB tint the chases. */
  pigment: number
  /** CH7 M-mode: 0 = solid RGB, 1–63 = RGB chases on the upper/lower matrix. */
  rgbPattern: number
  /** CH8 M speed. */
  rgbSpeed: number
  /** CH9 N-mode: 0 = solid white bar, 1–63 = white flow/flash in the centre. */
  wPattern: number
  /** CH10 N speed. */
  wSpeed: number
  /** CH11 P strobe overlay on whatever else is running. 0 = off. */
  strobe: number
  /** CH12 q-mode: 0 = use M+N, 1–63 = full built-in animations. */
  rgbwPattern: number
  /** CH13 q speed. */
  rgbwSpeed: number
  bgColor: number
  bgDimmer: number
}

const STROBE_OFF: StrobeCue = {
  dimmer: 0,
  r: 0,
  g: 0,
  b: 0,
  w: 0,
  pigment: 0,
  rgbPattern: 0,
  rgbSpeed: 0,
  wPattern: 0,
  wSpeed: 0,
  strobe: 0,
  rgbwPattern: 0,
  rgbwSpeed: 0,
  bgColor: 0,
  bgDimmer: 0
}

function strobeByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function strobeHsv(h: number, s: number, v: number): Pick<StrobeCue, 'r' | 'g' | 'b'> {
  const hh = ((h % 1) + 1) % 1
  const i = Math.floor(hh * 6)
  const f = hh * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  const m = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q]
  ][i % 6]
  return { r: strobeByte(m[0] * 255), g: strobeByte(m[1] * 255), b: strobeByte(m[2] * 255) }
}

function strobeBurstOn(tMs: number, onMs: number, periodMs: number): boolean {
  const p = Math.max(1, periodMs)
  return ((Math.max(0, tMs) % p) + p) % p < onMs
}

/** Menu M/N/q 0–63 → 15-CH DMX (4 steps per program). */
function lf4808Program(index: number): number {
  const n = Math.max(0, Math.min(63, Math.round(index)))
  return n <= 0 ? 0 : Math.min(252, n * 4)
}

function lf4808Cycle(tMs: number, periodMs: number, from: number, to: number): number {
  const span = Math.max(1, to - from + 1)
  return from + (Math.floor(Math.max(0, tMs) / Math.max(1, periodMs)) % span)
}

function lfCue(partial: Partial<StrobeCue>): StrobeCue {
  return { ...STROBE_OFF, dimmer: 255, ...partial }
}

/** LF4808 15-CH per the Betopper chart: dimmer, RGBW, pigment, M, M-spd, N, N-spd, P, q, q-spd, bg. */
function encodeStrobe15(start: number, cue: StrobeCue): DmxChannelValue[] {
  return pack([
    setRel(start, 0, cue.dimmer),
    setRel(start, 1, cue.r),
    setRel(start, 2, cue.g),
    setRel(start, 3, cue.b),
    setRel(start, 4, cue.w),
    setRel(start, 5, cue.pigment),
    setRel(start, 6, lf4808Program(cue.rgbPattern)),
    setRel(start, 7, cue.rgbSpeed),
    setRel(start, 8, lf4808Program(cue.wPattern)),
    setRel(start, 9, cue.wSpeed),
    setRel(start, 10, lf4808Strobe(cue.strobe)),
    setRel(start, 11, lf4808Program(cue.rgbwPattern)),
    setRel(start, 12, cue.rgbwSpeed),
    setRel(start, 13, cue.bgColor),
    setRel(start, 14, cue.bgDimmer)
  ])
}

/** P000 = off; low P values blink the whole head ~1 Hz and look broken. Keep flashes fast. */
const LF4808_STROBE_MIN = 205

export function lf4808Strobe(rate: number): number {
  if (rate <= 0) return 0
  return Math.max(LF4808_STROBE_MIN, Math.min(255, Math.round(rate)))
}

function strobeOverlay(tMs: number, rate: number, onMs = 380, periodMs = 1600): number {
  return strobeBurstOn(tMs, onMs, periodMs) ? lf4808Strobe(rate) : 0
}

/**
 * Drive the LF4808 like the sticks: always moving.
 * M+N = RGB matrix chase + white centre bar. q = 63 full animations. P = strobe overlay.
 */
function renderStrobe15(patternId: number, tMs: number): StrobeCue {
  const id = clampLedPatternId(patternId)
  const t = Math.max(0, tMs)
  switch (id) {
    case 0:
      // Knight Rider idle — barely on, crawl-speed chase, so the heads still look alive.
      return lfCue({
        dimmer: 16,
        r: 18,
        g: 28,
        b: 160,
        w: 0,
        rgbPattern: 3,
        rgbSpeed: 10,
        wPattern: 0,
        wSpeed: 0
      })
    case 99:
      return STROBE_OFF
    case 1:
      return lfCue({
        r: 20,
        g: 180,
        b: 110,
        w: 40,
        rgbPattern: lf4808Cycle(t, 2800, 8, 18),
        rgbSpeed: 110,
        wPattern: 6,
        wSpeed: 70,
        bgColor: 40,
        bgDimmer: 50
      })
    case 2:
      return lfCue({
        r: 255,
        g: 0,
        b: 200,
        w: 30,
        rgbPattern: lf4808Cycle(t, 1600, 20, 32),
        rgbSpeed: 200,
        wPattern: 12,
        wSpeed: 160
      })
    case 3:
      return lfCue({
        r: 0,
        g: 60,
        b: 255,
        w: 80,
        rgbPattern: lf4808Cycle(t, 2400, 4, 14),
        rgbSpeed: 90,
        wPattern: 8,
        wSpeed: 60,
        bgColor: 90,
        bgDimmer: 70
      })
    case 4:
      return lfCue({
        r: 255,
        g: 40,
        b: 0,
        w: 20,
        rgbPattern: lf4808Cycle(t, 1400, 24, 36),
        rgbSpeed: 180,
        wPattern: 10,
        wSpeed: 90
      })
    case 5:
      return lfCue({
        dimmer: 200,
        r: 40,
        g: 70,
        b: 180,
        w: 120,
        rgbPattern: 5,
        rgbSpeed: 50,
        wPattern: lf4808Cycle(t, 2200, 1, 8),
        wSpeed: 40,
        bgColor: 80,
        bgDimmer: 40
      })
    case 6:
      return lfCue({
        r: 0,
        g: 255,
        b: 40,
        w: 20,
        rgbPattern: lf4808Cycle(t, 900, 30, 45),
        rgbSpeed: 230,
        wPattern: 18,
        wSpeed: 200
      })
    case 7: {
      const rgb = strobeHsv(t / 7000, 1, 1)
      return lfCue({
        ...rgb,
        w: 40,
        rgbwPattern: lf4808Cycle(t, 2500, 8, 22),
        rgbwSpeed: 210
      })
    }
    case 8:
      return lfCue({
        r: 255,
        g: 0,
        b: 210,
        w: 60,
        rgbPattern: lf4808Cycle(t, 1200, 12, 24),
        rgbSpeed: 190,
        wPattern: 22,
        wSpeed: 170,
        strobe: strobeOverlay(t, 210, 220, 2000)
      })
    case 9:
      return lfCue({
        r: 90,
        g: 0,
        b: 255,
        w: 30,
        rgbPattern: lf4808Cycle(t, 2000, 40, 52),
        rgbSpeed: 80,
        wPattern: 14,
        wSpeed: 55,
        bgColor: 160,
        bgDimmer: 60
      })
    case 10:
      return lfCue({
        r: 255,
        g: 80,
        b: 255,
        w: 255,
        rgbPattern: lf4808Cycle(t, 800, 16, 28),
        rgbSpeed: 255,
        wPattern: lf4808Cycle(t, 700, 20, 40),
        wSpeed: 255,
        strobe: strobeOverlay(t, 160, 420, 1200)
      })
    case 11:
      return lfCue({
        r: 255,
        g: 40,
        b: 180,
        w: 255,
        rgbwPattern: lf4808Cycle(t, 1800, 1, 24),
        rgbwSpeed: 255,
        wPattern: lf4808Cycle(t, 900, 25, 45),
        wSpeed: 240,
        strobe: strobeOverlay(t, 130, 300, 900)
      })
    case 12:
      return lfCue({
        r: 0,
        g: 255,
        b: 90,
        w: 40,
        rgbPattern: lf4808Cycle(t, 700, 33, 48),
        rgbSpeed: 255,
        wPattern: 16,
        wSpeed: 180
      })
    case 13:
      return lfCue({
        r: 255,
        g: 20,
        b: 0,
        w: strobeBurstOn(t, 180, 500) ? 255 : 40,
        rgbPattern: 22,
        rgbSpeed: 160,
        wPattern: lf4808Cycle(t, 500, 30, 50),
        wSpeed: 255,
        strobe: strobeBurstOn(t, 140, 500) ? 220 : 0
      })
    case 14:
      return lfCue({
        r: 255,
        g: 80,
        b: 0,
        w: 80,
        rgbwPattern: lf4808Cycle(t, 1100, 25, 50),
        rgbwSpeed: 255,
        wPattern: 28,
        wSpeed: 220
      })
    case 15:
      return lfCue({
        r: 255,
        g: 0,
        b: 80,
        w: 120,
        rgbPattern: lf4808Cycle(t, 500, 40, 63),
        rgbSpeed: 255,
        wPattern: lf4808Cycle(t, 480, 35, 60),
        wSpeed: 255
      })
    case 16: {
      const rgb = strobeHsv(t / 5000, 1, 1)
      return lfCue({
        ...rgb,
        w: 90,
        rgbwPattern: lf4808Cycle(t, 1600, 10, 35),
        rgbwSpeed: 230,
        strobe: strobeOverlay(t, 100, 280, 1400)
      })
    }
    case 17:
      return lfCue({
        r: 255,
        g: 180,
        b: 20,
        w: 160,
        rgbPattern: lf4808Cycle(t, 1000, 6, 20),
        rgbSpeed: 200,
        wPattern: lf4808Cycle(t, 800, 8, 24),
        wSpeed: 210
      })
    case 18:
      return lfCue({
        r: 255,
        g: 0,
        b: 160,
        w: 255,
        rgbwPattern: lf4808Cycle(t, 900, 40, 63),
        rgbwSpeed: 255,
        wPattern: lf4808Cycle(t, 400, 40, 63),
        wSpeed: 255,
        strobe: strobeOverlay(t, 180, 520, 1000)
      })
    case 19:
      return lfCue({
        r: 255,
        g: 50,
        b: 0,
        w: 80,
        rgbPattern: lf4808Cycle(t, 650, 18, 38),
        rgbSpeed: 240,
        wPattern: 20,
        wSpeed: 200,
        strobe: strobeOverlay(t, 215, 200, 1100)
      })
    case 20:
      return lfCue({
        r: 255,
        g: 0,
        b: 255,
        w: 255,
        rgbwPattern: lf4808Cycle(t, 1400, 1, 63),
        rgbwSpeed: 255,
        strobe: strobeOverlay(t, 150, 360, 1100)
      })
    case 21:
      return lfCue({
        dimmer: 40,
        r: 0,
        g: 30,
        b: 160,
        w: 10
      })
    default:
      return STROBE_OFF
  }
}

const IDLE_DOME: DomeCue = {
  dimmer: 12,
  r: 18,
  g: 28,
  b: 160,
  w: 0,
  rotate: 5,
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

/** LF4808 strobes — different look than ESP, sticks, and dome. */
export function complementaryStrobePatternId(espPatternId: number): number {
  return partyPatternId(espPatternId, 4)
}

export function dmxUniverseForLedPattern(
  patternId: number,
  tMs = 0,
  stickBrightness = 1,
  opts?: { stickPatternId?: number; domePatternId?: number; strobePatternId?: number }
): DmxChannelValue[] {
  if (patternId === 99) return []
  const knightRider = patternId === 0
  const stickId = clampLedPatternId(opts?.stickPatternId ?? complementaryStickPatternId(patternId))
  const domeId = knightRider
    ? 0
    : clampLedPatternId(opts?.domePatternId ?? complementaryDomePatternId(patternId))
  const strobeId = knightRider
    ? 0
    : opts?.strobePatternId !== undefined
      ? clampLedPatternId(opts.strobePatternId)
      : patternId === 21
        ? 99
        : complementaryStrobePatternId(patternId)
  const dome = LED_DOME_CUES[domeId] ?? LED_DOME_CUES[7]
  return [
    ...encodeStick48(DMX_FREEDOM_STICK_START, renderStickPixels(stickId, tMs, stickBrightness)),
    ...encodeDome(DMX_POWERDOME_START, dome),
    ...encodeStrobe15(DMX_STROBE_START, renderStrobe15(strobeId, tMs))
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
