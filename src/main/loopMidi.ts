import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const EXE_NAME = 'loopMIDI.exe'

function loopMidiCandidates(): string[] {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    join(pf, 'Tobias Erichsen', 'loopMIDI', EXE_NAME),
    join(pf86, 'Tobias Erichsen', 'loopMIDI', EXE_NAME)
  ]
}

function isLoopMidiRunning(): boolean {
  if (process.platform !== 'win32') return true
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${EXE_NAME}"`, {
      encoding: 'utf8',
      windowsHide: true
    })
    return out.toLowerCase().includes(EXE_NAME.toLowerCase())
  } catch {
    return false
  }
}

function findLoopMidiExe(): string | null {
  for (const p of loopMidiCandidates()) {
    if (existsSync(p)) return p
  }
  return null
}

/** Start loopMIDI if installed and not already running (Windows). Cubase ↔ ViewerOne virtual cable. */
export function ensureLoopMidiRunning(): void {
  if (process.platform !== 'win32') return
  if (isLoopMidiRunning()) {
    console.log('[ViewerOne] loopMIDI is already running')
    return
  }
  const exe = findLoopMidiExe()
  if (!exe) {
    console.warn(
      '[ViewerOne] loopMIDI not found in default install path — install from https://www.tobias-erichsen.de/software/loopmidi.html if you need a virtual MIDI port for Cubase.'
    )
    return
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
    child.unref()
    console.log('[ViewerOne] Started loopMIDI:', exe)
  } catch (e) {
    console.warn('[ViewerOne] Failed to start loopMIDI:', e)
  }
}
