/** LED patterns — keep in sync with firmware `led_config.h` / `patternName()`. */

export type LedPatternDef = {
  id: number
  /** Underscored id sent to / from ESP */
  name: string
  /** Short label for setlist dropdown (zero-padded id prefix) */
  label: string
}

/** Zero-padded id matching pattern id: 0 → `00 - …`, 20 → `20 - …`. */
function numberedLabel(id: number, title: string): string {
  return `${String(id).padStart(2, '0')} - ${title}`
}

export const LED_PATTERNS: readonly LedPatternDef[] = [
  { id: 0, name: 'knight_rider', label: numberedLabel(0, 'Knight Rider') },
  { id: 1, name: 'aurora', label: numberedLabel(1, 'Aurora') },
  { id: 2, name: 'dual_comet', label: numberedLabel(2, 'Dual Comet') },
  { id: 3, name: 'ocean', label: numberedLabel(3, 'Ocean') },
  { id: 4, name: 'lava', label: numberedLabel(4, 'Lava') },
  { id: 5, name: 'starfield', label: numberedLabel(5, 'Starfield') },
  { id: 6, name: 'cyber_rain', label: numberedLabel(6, 'Cyber Rain') },
  { id: 7, name: 'rainbow_ripple', label: numberedLabel(7, 'Rainbow Ripple') },
  { id: 8, name: 'neon_pulse', label: numberedLabel(8, 'Neon Pulse') },
  { id: 9, name: 'galaxy', label: numberedLabel(9, 'Galaxy') },
  { id: 10, name: 'strobe_wave', label: numberedLabel(10, 'Strobe Wave') },
  { id: 11, name: 'disco_ball', label: numberedLabel(11, 'Disco Ball') },
  { id: 12, name: 'laser_sweep', label: numberedLabel(12, 'Laser Sweep') },
  { id: 13, name: 'bass_pulse', label: numberedLabel(13, 'Bass Pulse') },
  { id: 14, name: 'confetti_storm', label: numberedLabel(14, 'Confetti Storm') },
  { id: 15, name: 'hyper_chase', label: numberedLabel(15, 'Hyper Chase') },
  { id: 16, name: 'prism_spin', label: numberedLabel(16, 'Prism Spin') },
  { id: 17, name: 'spark_shower', label: numberedLabel(17, 'Spark Shower') },
  { id: 18, name: 'color_bomb', label: numberedLabel(18, 'Color Bomb') },
  { id: 19, name: 'roller_derby', label: numberedLabel(19, 'Roller Derby') },
  { id: 20, name: 'random', label: numberedLabel(20, 'Random') }
] as const

/** Boot / waiting-only pattern — songs should not prefer this. */
export const DEFAULT_LED_PATTERN_ID = 0

/** Default song pattern: sequential rotator through busy disco set (1..19). */
export const RANDOM_LED_PATTERN_ID = 20

/** @deprecated Prefer RANDOM_LED_PATTERN_ID — songs all use random now. */
export const FIRST_SONG_LED_PATTERN_ID = 1

/** Pattern id for any setlist song — always random (20). */
export function songLedPatternForIndex(_index?: number): number {
  return RANDOM_LED_PATTERN_ID
}

export function clampLedPatternId(id: unknown): number {
  const n = typeof id === 'number' ? id : Number(id)
  if (!Number.isFinite(n)) return DEFAULT_LED_PATTERN_ID
  const i = Math.trunc(n)
  if (i < 0 || i >= LED_PATTERNS.length) return DEFAULT_LED_PATTERN_ID
  return i
}

export function ledPatternName(id: number): string {
  return LED_PATTERNS[clampLedPatternId(id)]?.name ?? 'knight_rider'
}

export function formatLedPatternLabel(nameOrId: string | number | undefined): string {
  if (typeof nameOrId === 'number') {
    return LED_PATTERNS[clampLedPatternId(nameOrId)]?.label ?? numberedLabel(0, 'Knight Rider')
  }
  const raw = (nameOrId ?? 'knight_rider').trim() || 'knight_rider'
  const found = LED_PATTERNS.find((p) => p.name === raw)
  if (found) return found.label
  return raw.replace(/_/g, ' ')
}

/** Max brightness when LEDs are powered from ESP32/USB (not external PSU). */
export const LED_USB_BRIGHTNESS_CAP = 56

/** Default when external PSU is off — modest and under the USB cap. */
export const LED_DEFAULT_BRIGHTNESS = 40

export function clampLedBrightness(value: unknown, externalPower: boolean): number {
  let n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) n = LED_DEFAULT_BRIGHTNESS
  n = Math.round(n)
  if (n < 0) n = 0
  if (n > 255) n = 255
  if (!externalPower && n > LED_USB_BRIGHTNESS_CAP) n = LED_USB_BRIGHTNESS_CAP
  return n
}
