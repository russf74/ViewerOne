/**
 * No dropdowns: MIDI port names are matched by keyword so the right devices are picked up
 * automatically whenever they're plugged in / loopMIDI is running, in whichever order.
 */

export type MidiPortPair = { input: string | null; output: string | null }

function classifyCubasePort(name: string): 'in' | 'out' | null {
  const lower = name.toLowerCase()
  if (!lower.includes('cubase')) return null
  const viewerIdx = lower.search(/viewer\s*one|viewer1/)
  if (viewerIdx === -1) return null
  const cubaseIdx = lower.indexOf('cubase')
  return cubaseIdx < viewerIdx ? 'in' : 'out'
}

/** Cubase relays song changes + auto-mute over a pair of loopMIDI cables, e.g. "CubaseToViewerOne" / "ViewerOneToCubase". */
export function detectCubasePorts(inputs: string[], outputs: string[]): MidiPortPair {
  const input = inputs.find((n) => classifyCubasePort(n) === 'in') ?? null
  const output = outputs.find((n) => classifyCubasePort(n) === 'out') ?? null
  return { input, output }
}

const MIXER_KEYWORDS = ['x-usb', 'xusb', 'x32', 'xair', 'm32', 'behringer']

function hasMixerKeyword(lower: string): boolean {
  return MIXER_KEYWORDS.some((k) => lower.includes(k))
}

/** Read-only helper kept for callers that only care about the mixer's input side. */
export function detectMixerInputPort(inputs: string[]): string | null {
  return inputs.find((n) => hasMixerKeyword(n.toLowerCase())) ?? null
}

/**
 * The mixer's own USB MIDI ports, matched independently in each list (e.g. "X-USB MIDI IN" /
 * "X-USB MIDI OUT") so ViewerOne can talk to it directly, two-way, without going through Cubase.
 * Trusts whatever the OS/driver already classifies as input vs output rather than guessing.
 */
export function detectMixerPorts(inputs: string[], outputs: string[]): MidiPortPair {
  const input = inputs.find((n) => hasMixerKeyword(n.toLowerCase())) ?? null
  const output = outputs.find((n) => hasMixerKeyword(n.toLowerCase())) ?? null
  return { input, output }
}
