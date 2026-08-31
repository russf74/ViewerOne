/** Parse ffmpeg DirectShow device lists and match a saved loopback name. */

const LOOPBACK_HINTS = [
  'stereo mix',
  'wave out mix',
  'what u hear',
  'loopback',
  'cable output',
  'voicemeeter'
]

export function isLikelyLoopbackDevice(name: string): boolean {
  const n = name.toLowerCase()
  return LOOPBACK_HINTS.some((h) => n.includes(h))
}

/** Unique audio device names from ffmpeg `-f dshow -list_devices true` output. */
export function parseDshowAudioDevices(output: string): string[] {
  const names: string[] = []
  let inAudio = false
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (/directshow audio devices/i.test(line)) {
      inAudio = true
      continue
    }
    if (/directshow video devices/i.test(line)) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    if (/alternative name/i.test(line)) continue
    const quoted = line.match(/"([^"]+)"/)
    if (quoted?.[1]) names.push(quoted[1])
  }
  return [...new Set(names)]
}

/** Stereo Mix / VB-Cable first, then the rest A–Z. */
export function sortAudioDevices(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const al = isLikelyLoopbackDevice(a) ? 0 : 1
    const bl = isLikelyLoopbackDevice(b) ? 0 : 1
    if (al !== bl) return al - bl
    return a.localeCompare(b)
  })
}

/**
 * Map a saved free-text name (e.g. "Stereo Mix") onto an enabled device.
 * Exact match first, then unique prefix / contains match.
 */
export function resolveLoopbackDevice(saved: string, devices: string[]): string | null {
  if (devices.length === 0) return null
  const want = saved.trim()
  if (!want) {
    const hinted = devices.filter(isLikelyLoopbackDevice)
    return hinted.length === 1 ? hinted[0] : null
  }
  const exact = devices.find((d) => d === want)
  if (exact) return exact
  const ci = devices.find((d) => d.toLowerCase() === want.toLowerCase())
  if (ci) return ci

  const lower = want.toLowerCase()
  const prefixed = devices.filter(
    (d) => d.toLowerCase().startsWith(lower) || lower.startsWith(d.toLowerCase())
  )
  if (prefixed.length === 1) return prefixed[0]

  const contained = devices.filter((d) => d.toLowerCase().includes(lower))
  if (contained.length === 1) return contained[0]

  if (lower === 'stereo mix' || lower === 'stereomix') {
    const mixes = devices.filter((d) => d.toLowerCase().includes('stereo mix'))
    if (mixes.length === 1) return mixes[0]
  }
  return null
}
