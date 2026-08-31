import type { DmxCueOverride } from './lightingProgram.js'
import { dmxValueForMode } from './dmx.js'

type DmxChannelValue = { channel: number; value: number }

/** Merge per-cue DMX overrides onto a computed universe. */
export function mergeDmxCueOverrides(
  channels: DmxChannelValue[],
  override: DmxCueOverride | undefined,
  fixture1Channel: number,
  fixture2Channel: number
): DmxChannelValue[] {
  if (!override) return channels
  const m = new Map<number, number>()
  for (const c of channels) m.set(c.channel, c.value)

  if (override.powerDomeDimmer !== undefined) {
    m.set(fixture2Channel, Math.max(0, Math.min(255, override.powerDomeDimmer)))
  }
  if (override.powerDomeAuto !== undefined && override.powerDomeAuto > 0) {
    const auto = Math.max(1, Math.min(5, override.powerDomeAuto))
    const autoVal = [18, 43, 73, 93, 118][auto - 1] ?? 18
    m.set(fixture2Channel + 7, autoVal)
    m.set(fixture2Channel + 8, 255)
  }
  if (override.fixture1Mode) {
    m.set(fixture1Channel, dmxValueForMode(override.fixture1Mode))
  }
  if (override.fixture2Mode) {
    m.set(fixture2Channel, dmxValueForMode(override.fixture2Mode))
  }

  return [...m.entries()].map(([channel, value]) => ({ channel, value }))
}
