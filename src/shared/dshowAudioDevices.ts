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
  const tagged: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (/alternative name/i.test(line)) continue
    const taggedMatch = line.match(/"([^"]+)"\s*\((audio|video)\)/i)
    if (taggedMatch?.[1] && taggedMatch[2].toLowerCase() === 'audio') {
      tagged.push(taggedMatch[1])
    }
  }
  if (tagged.length > 0) return [...new Set(tagged)]

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
    if (quoted?.[1] && !quoted[1].startsWith('@device')) names.push(quoted[1])
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

/** ffmpeg dshow input. Do not wrap the name in extra quotes — Node spawn already quotes the argv. */
export function dshowAudioFilename(deviceName: string): string {
  const name = deviceName.trim()
  if (!name) return 'audio=Stereo Mix'
  return `audio=${name}`
}

/** Prefer the real dshow reason over ffmpeg's generic last line. */
export function formatDshowOpenError(stderr: string, deviceName: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[dshow[^\]]*\]\s*/i, '').trim())
    .filter(Boolean)
  const useful = [...lines]
    .reverse()
    .find(
      (l) =>
        /could not|not find|permission|denied|busy|in use|no such/i.test(l) &&
        !/opening input files/i.test(l)
    )
  if (/i\/o error/i.test(stderr) || /could not find/i.test(stderr) || /could not audio/i.test(stderr)) {
    const shown = deviceName.trim() || 'this device'
    return `Can't open “${shown}”. Enable it in Sound → Recording (Show Disabled Devices), allow Microphone for desktop apps, Refresh, and pick the full name — not just “Stereo Mix”.`
  }
  return useful ?? lines[lines.length - 1] ?? 'Loopback open failed'
}
