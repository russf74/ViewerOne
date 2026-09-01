/** Read beat times from a Moises (or any) metronome WAV — sparse clicks on silence. */

export function medianBpmFromOnsets(onsetsMs: number[]): number {
  if (onsetsMs.length < 4) return 120
  const iois: number[] = []
  for (let i = 1; i < onsetsMs.length; i++) {
    const d = onsetsMs[i]! - onsetsMs[i - 1]!
    if (d > 180 && d < 1200) iois.push(d)
  }
  if (iois.length < 2) return 120
  iois.sort((a, b) => a - b)
  const median = iois[Math.floor(iois.length / 2)]!
  return 60000 / median
}

/**
 * Sample-accurate click times (ms) from a metronome recording.
 * Min gap starts loose, then locks to ~0.7 of the median spacing.
 */
export function metronomeOnsetsMs(samples: Float32Array, sampleRate: number): number[] {
  if (samples.length < sampleRate * 0.5) return []
  const hop = Math.max(1, Math.round(sampleRate * 0.002))
  const nHop = Math.floor(samples.length / hop)
  const energy = new Float32Array(nHop)
  for (let i = 0; i < nHop; i++) {
    let e = 0
    const start = i * hop
    for (let k = 0; k < hop; k++) e += samples[start + k]! * samples[start + k]!
    energy[i] = Math.sqrt(e / hop)
  }
  const nov = new Float32Array(nHop)
  nov[0] = energy[0] ?? 0
  for (let i = 1; i < nHop; i++) nov[i] = Math.max(0, energy[i]! - energy[i - 1]!)
  let peak = 0
  for (let i = 0; i < nHop; i++) if (nov[i]! > peak) peak = nov[i]!
  if (peak < 1e-8) return []
  const pick = (minGapMs: number, thr: number): number[] => {
    const minGap = minGapMs / ((hop / sampleRate) * 1000)
    const times: number[] = []
    let last = -1e9
    for (let i = 0; i < nHop - 1; i++) {
      if (nov[i]! < thr) continue
      const prev = i > 0 ? nov[i - 1]! : 0
      if (nov[i]! < prev || nov[i]! < nov[i + 1]!) continue
      if (i - last < minGap) continue
      const approx = i * hop
      times.push((refinePeakSample(samples, approx, hop * 4) / sampleRate) * 1000)
      last = i
    }
    return times
  }
  const coarse = pick(180, peak * 0.18)
  if (coarse.length < 8) return coarse
  const iois = coarse.slice(1).map((t, i) => t - coarse[i]!)
  iois.sort((a, b) => a - b)
  const median = iois[Math.floor(iois.length / 2)]!
  return pick(Math.max(180, median * 0.68), peak * 0.15)
}

function refinePeakSample(samples: Float32Array, approx: number, win: number): number {
  let best = approx
  let bestA = 0
  const lo = Math.max(0, approx - win)
  const hi = Math.min(samples.length - 1, approx + win)
  for (let i = lo; i <= hi; i++) {
    const a = Math.abs(samples[i]!)
    if (a > bestA) {
      bestA = a
      best = i
    }
  }
  return best
}

/** Which click in each bar is the downbeat (0 = first click), scored on song kick energy. */
export function pickDownbeatPhase(
  onsetsMs: number[],
  song: Float32Array | undefined,
  songRate: number,
  beatsPerBar = 4
): number {
  if (!song || song.length < songRate || onsetsMs.length < beatsPerBar * 4) return 0
  const scores = new Array(beatsPerBar).fill(0)
  const win = Math.round(songRate * 0.025)
  const hpA = 1 - Math.exp((-2 * Math.PI * 40) / songRate)
  const lpA = 1 - Math.exp((-2 * Math.PI * 180) / songRate)
  const envAt = (tMs: number): number => {
    const c = Math.round((tMs / 1000) * songRate)
    let s = 0
    let n = 0
    let slow = 0
    let fast = 0
    for (let i = c - win; i <= c + win; i++) {
      if (i < 0 || i >= song.length) continue
      const x = song[i] ?? 0
      slow += hpA * (x - slow)
      const high = x - slow
      fast += lpA * (high - fast)
      s += fast * fast
      n++
    }
    return n ? Math.sqrt(s / n) : 0
  }
  for (let i = 0; i < onsetsMs.length; i++) {
    scores[i % beatsPerBar] += envAt(onsetsMs[i]!)
  }
  let best = 0
  for (let p = 1; p < beatsPerBar; p++) if (scores[p]! > scores[best]!) best = p
  return best
}
