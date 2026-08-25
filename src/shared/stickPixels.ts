/** Freedom Stick 48-CH: 16 RGB cells. Host animates; fixture autos are unused. */

export const STICK_PIXEL_COUNT = 16

export type Rgb = [number, number, number]

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function hsv(h: number, s: number, v: number): Rgb {
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
  return [clampByte(m[0] * 255), clampByte(m[1] * 255), clampByte(m[2] * 255)]
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

function scaleRgb(c: Rgb, b: number): Rgb {
  return [clampByte(c[0] * b), clampByte(c[1] * b), clampByte(c[2] * b)]
}

function addRgb(a: Rgb, r: number, g: number, b: number): void {
  a[0] = clampByte(a[0] + r)
  a[1] = clampByte(a[1] + g)
  a[2] = clampByte(a[2] + b)
}

function blank(): Rgb[] {
  return Array.from({ length: STICK_PIXEL_COUNT }, () => [0, 0, 0] as Rgb)
}

function fill(pixels: Rgb[], c: Rgb): void {
  for (let i = 0; i < STICK_PIXEL_COUNT; i++) {
    pixels[i][0] = c[0]
    pixels[i][1] = c[1]
    pixels[i][2] = c[2]
  }
}

function comet(pixels: Rgb[], pos: number, rgb: Rgb, tail: number): void {
  for (let k = 0; k < tail; k++) {
    const i = Math.round(pos) - k
    if (i < 0 || i >= STICK_PIXEL_COUNT) continue
    const fade = (1 - k / tail) ** 1.4
    addRgb(pixels[i], rgb[0] * fade, rgb[1] * fade, rgb[2] * fade)
  }
}

/** Party looks stay busy on 16 cells. Pattern 0/21 are the calm exceptions. */
export function renderStickPixels(patternId: number, tMs: number, brightness = 1): Rgb[] {
  const t = Math.max(0, tMs) / 1000
  const n = STICK_PIXEL_COUNT
  const pixels = blank()
  const id = Math.max(0, Math.min(21, Math.round(patternId)))

  switch (id) {
    case 0: {
      const cycle = 0.55
      const u = (t / cycle) % 2
      const pos = u < 1 ? u * (n - 1) : (2 - u) * (n - 1)
      comet(pixels, pos, [48, 64, 255], 5)
      break
    }
    case 1: {
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1)
        const a = 0.55 + 0.45 * Math.sin(x * 9 + t * 8.5)
        const b = 0.45 + 0.55 * Math.sin(x * 6 - t * 6.2 + 1.7)
        pixels[i] = hsv(0.42 + 0.12 * Math.sin(t * 0.7) + x * 0.18, 0.85, a * 0.55 + b * 0.55)
      }
      break
    }
    case 2: {
      comet(pixels, (t * 22) % (n + 6) - 2, [255, 30, 200], 6)
      comet(pixels, n + 1 - ((t * 18) % (n + 6)), [0, 255, 220], 6)
      break
    }
    case 3: {
      for (let i = 0; i < n; i++) {
        const wave = 0.35 + 0.65 * Math.sin(i * 0.9 - t * 10)
        pixels[i] = hsv(0.52 + 0.08 * wave, 0.9, 0.35 + 0.65 * wave)
      }
      break
    }
    case 4: {
      for (let i = 0; i < n; i++) {
        const flicker = 0.55 + 0.45 * hash(i * 19 + Math.floor(t * 18))
        const heat = flicker * (0.25 + 0.75 * (i / (n - 1)))
        pixels[i] = hsv(0.04 + 0.06 * heat, 1, 0.35 + 0.65 * heat)
      }
      break
    }
    case 5: {
      fill(pixels, [50, 110, 255])
      for (let i = 0; i < n; i++) {
        const spark = hash(i * 91 + Math.floor(t * 14 + i * 0.3))
        if (spark > 0.78) {
          pixels[i] = [255, 255, 255]
        } else if (spark > 0.64) {
          const w = (spark - 0.64) / 0.14
          pixels[i] = [
            50 + 205 * w,
            110 + 145 * w,
            255
          ]
        }
      }
      break
    }
    case 6: {
      fill(pixels, [0, 12, 0])
      for (let k = 0; k < 4; k++) {
        const pos = n - 1 - ((t * (10 + k * 3) + k * 4.2) % (n + 3))
        comet(pixels, pos, [40, 255, 70], 4)
      }
      break
    }
    case 7: {
      for (let i = 0; i < n; i++) {
        pixels[i] = hsv((i / n) * 0.85 + t * 0.55, 1, 1)
      }
      break
    }
    case 8: {
      const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 14))
      const hue = Math.floor(t * 2) % 2 === 0 ? 0.92 : 0.52
      fill(pixels, hsv(hue, 1, pulse * 0.35))
      comet(pixels, (t * 20) % (n + 4) - 1, hsv(hue, 1, 1), 4)
      break
    }
    case 9: {
      for (let i = 0; i < n; i++) {
        const tw = hash(i * 17 + Math.floor(t * 9))
        pixels[i] = hsv(0.72 + 0.08 * tw, 0.85, 0.15 + 0.85 * tw)
      }
      comet(pixels, (t * 9) % (n + 8) - 3, [180, 80, 255], 7)
      break
    }
    case 10: {
      fill(pixels, hsv((Math.floor(t * 3) % 6) / 6, 1, 0.18))
      const pos = (t * 28) % (n + 2)
      comet(pixels, pos, [255, 255, 255], 3)
      comet(pixels, pos - 8, [255, 80, 255], 3)
      break
    }
    case 11: {
      for (let i = 0; i < n; i++) {
        const on = hash(i * 33 + Math.floor(t * 16))
        if (on > 0.55) pixels[i] = hsv(hash(i * 8 + Math.floor(t * 4)), 1, on)
      }
      break
    }
    case 12: {
      fill(pixels, [0, 8, 0])
      comet(pixels, (t * 26) % (n + 5) - 2, [40, 255, 80], 3)
      break
    }
    case 13: {
      const beat = Math.abs(Math.sin(t * 11))
      const body = hsv(0.02, 1, 0.2 + 0.8 * beat)
      fill(pixels, body)
      comet(pixels, beat * (n - 1), [255, 220, 40], 4)
      break
    }
    case 14: {
      for (let i = 0; i < n; i++) {
        const h = hash(i * 21 + Math.floor(t * 12))
        pixels[i] = hsv(h, 1, 0.55 + 0.45 * hash(i + Math.floor(t * 20)))
      }
      break
    }
    case 15: {
      const phase = Math.floor(t * 14) % 3
      const hue = (t * 0.35) % 1
      for (let i = 0; i < n; i++) {
        pixels[i] = i % 3 === phase ? hsv(hue + i * 0.04, 1, 1) : [0, 0, 0]
      }
      break
    }
    case 16: {
      for (let i = 0; i < n; i++) {
        pixels[i] = hsv(t * 0.7 + i / n, 1, 1)
      }
      break
    }
    case 17: {
      fill(pixels, [12, 4, 0])
      for (let k = 0; k < 5; k++) {
        const pos = n - 1 - ((t * (14 + k * 2.5) + k * 3.1) % (n + 2))
        comet(pixels, pos, hsv(0.08 + hash(k) * 0.12, 0.6, 1), 3)
      }
      break
    }
    case 18: {
      const hue = (t * 0.45) % 1
      const radius = (t * 8) % (n / 2 + 2)
      const mid = (n - 1) / 2
      for (let i = 0; i < n; i++) {
        const d = Math.abs(i - mid)
        const ring = Math.max(0, 1 - Math.abs(d - radius))
        pixels[i] = hsv(hue + d * 0.05, 1, 0.15 + 0.85 * ring)
      }
      break
    }
    case 19: {
      comet(pixels, (t * 16) % (n + 5) - 2, [255, 40, 40], 4)
      comet(pixels, (t * 16 + n / 3) % (n + 5) - 2, [40, 255, 80], 4)
      comet(pixels, (t * 16 + (2 * n) / 3) % (n + 5) - 2, [40, 80, 255], 4)
      break
    }
    case 21: {
      fill(pixels, [0, 36, 160])
      break
    }
    default: {
      for (let i = 0; i < n; i++) {
        pixels[i] = hsv(t * 0.5 + i / n, 1, 1)
      }
    }
  }

  if (brightness >= 0.999) return pixels
  return pixels.map((c) => scaleRgb(c, brightness))
}
