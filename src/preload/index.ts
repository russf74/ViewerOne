import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, PublicState, SetlistItem } from '../shared/types.js'

const api = {
  getState: (): Promise<PublicState> => ipcRenderer.invoke('state:get'),
  onState: (fn: (s: PublicState) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, s: PublicState) => fn(s)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.removeListener('state:update', listener)
  },
  setSetlist: (items: SetlistItem[]): Promise<PublicState> => ipcRenderer.invoke('setlist:set', items),
  addSong: (): Promise<PublicState> => ipcRenderer.invoke('setlist:add'),
  removeSong: (id: string): Promise<PublicState> => ipcRenderer.invoke('setlist:remove', id),
  prevSong: (): Promise<PublicState> => ipcRenderer.invoke('setlist:prevSong'),
  nextSong: (): Promise<PublicState> => ipcRenderer.invoke('setlist:nextSong'),
  previewPrev: (): Promise<PublicState> => ipcRenderer.invoke('setlist:previewPrev'),
  previewNext: (): Promise<PublicState> => ipcRenderer.invoke('setlist:previewNext'),
  selectSong: (id: string | null): Promise<PublicState> => ipcRenderer.invoke('setlist:selectSong', id),
  patchSettings: (patch: Partial<AppState>): Promise<PublicState> =>
    ipcRenderer.invoke('settings:patch', patch),
  refreshMidi: (): Promise<PublicState> => ipcRenderer.invoke('midi:refresh'),
  arrangerPrev: (): Promise<PublicState> => ipcRenderer.invoke('arranger:prev'),
  arrangerNext: (): Promise<PublicState> => ipcRenderer.invoke('arranger:next'),
  scanArranger: (): Promise<PublicState> => ipcRenderer.invoke('arranger:scan'),
  cancelArrangerScan: (): Promise<PublicState> => ipcRenderer.invoke('arranger:cancelScan'),
  grabCubaseLength: (): Promise<PublicState> => ipcRenderer.invoke('arranger:grabLength'),
  /** Simulate an absolute CrowPanel prompt PC (120–123). */
  promptMidi: (pc: 120 | 121 | 122 | 123): Promise<PublicState> =>
    ipcRenderer.invoke('prompt:midi', pc),
  /** Simulate Cubase PC 125 — LED blackout (pattern id 99). */
  ledMidiBlackout: (): Promise<PublicState> => ipcRenderer.invoke('led:midiBlackout'),
  /** Simulate Cubase PC 126 — dim royal blue knight rider (idle lights). */
  ledMidiIdle: (): Promise<PublicState> => ipcRenderer.invoke('led:midiIdle'),
  /** Simulate Cubase PC 127 — apply current song pattern. */
  ledMidiApply: (): Promise<PublicState> => ipcRenderer.invoke('led:midiApply'),
  /** Live-test pattern id 0–20 or 99 on the ESP (does not change the song’s stored pattern). */
  previewLedPattern: (id: number): Promise<PublicState> =>
    ipcRenderer.invoke('led:previewPattern', id),
  pickBackingTrack: (songId: string): Promise<PublicState> =>
    ipcRenderer.invoke('lighting:pickBackingTrack', songId),
  analyzeSongLighting: (songId: string): Promise<PublicState> =>
    ipcRenderer.invoke('lighting:analyzeSong', songId),
  analyzeAllLighting: (): Promise<PublicState> => ipcRenderer.invoke('lighting:analyzeAll'),
  analyzeLightingFromCubase: (): Promise<PublicState> =>
    ipcRenderer.invoke('lighting:analyzeFromCubase'),
  cancelLightingAnalyze: (): Promise<PublicState> => ipcRenderer.invoke('lighting:cancelAnalyze'),
  setLightingProgram: (songId: string, program: unknown): Promise<PublicState> =>
    ipcRenderer.invoke('lighting:setProgram', songId, program),
  listLoopbackDevices: (): Promise<string[]> => ipcRenderer.invoke('lighting:listLoopbackDevices')
}

contextBridge.exposeInMainWorld('viewer', api)

export type ViewerApi = typeof api
