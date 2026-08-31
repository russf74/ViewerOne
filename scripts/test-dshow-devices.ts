import {
  isLikelyLoopbackDevice,
  parseDshowAudioDevices,
  resolveLoopbackDevice,
  sortAudioDevices
} from '../src/shared/dshowAudioDevices.js'

const ffmpegDump = `
[dshow @ 000001] DirectShow video devices (some may be unavailable)
[dshow @ 000001]  "Integrated Camera"
[dshow @ 000001]     Alternative name "@device_pnp_\\\\?\\usb#vid"
[dshow @ 000001] DirectShow audio devices (some may be unavailable)
[dshow @ 000001]  "Microphone Array (Intel(R) Smart Sound Technology for Digital Microphones)"
[dshow @ 000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{1}"
[dshow @ 000001]  "Jack Mic (Realtek(R) Audio)"
[dshow @ 000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{2}"
[dshow @ 000001]  "Stereo Mix (Realtek(R) Audio)"
[dshow @ 000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{3}"
`

const names = parseDshowAudioDevices(ffmpegDump)
if (names.length !== 3) throw new Error(`expected 3 audio devices, got ${names.length}: ${names.join(' | ')}`)
if (names.includes('Integrated Camera')) throw new Error('video device leaked into audio list')
if (names.some((n) => n.startsWith('@device'))) throw new Error('alternative name leaked')

const sorted = sortAudioDevices(names)
if (sorted[0] !== 'Stereo Mix (Realtek(R) Audio)') {
  throw new Error(`Stereo Mix should sort first, got ${sorted[0]}`)
}
if (!isLikelyLoopbackDevice(sorted[0])) throw new Error('Stereo Mix not flagged as loopback')

const resolved = resolveLoopbackDevice('Stereo Mix', names)
if (resolved !== 'Stereo Mix (Realtek(R) Audio)') {
  throw new Error(`short name should resolve, got ${resolved}`)
}
if (resolveLoopbackDevice('Stereo Mix (Realtek(R) Audio)', names) !== 'Stereo Mix (Realtek(R) Audio)') {
  throw new Error('exact name should stay')
}
if (resolveLoopbackDevice('stereo mix', names) !== 'Stereo Mix (Realtek(R) Audio)') {
  throw new Error('case-insensitive short name should resolve')
}
if (resolveLoopbackDevice('Microphone Array', names) == null) {
  throw new Error('unique prefix of mic array should resolve')
}

console.log('dshow-devices: OK', sorted)
