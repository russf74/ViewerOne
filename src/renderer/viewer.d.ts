import type { AppState, PublicState, SetlistItem } from '../shared/types'

export type ViewerApi = {
  getState: () => Promise<PublicState>
  onState: (fn: (s: PublicState) => void) => () => void
  setSetlist: (items: SetlistItem[]) => Promise<PublicState>
  addSong: () => Promise<PublicState>
  removeSong: (id: string) => Promise<PublicState>
  prevSong: () => Promise<PublicState>
  nextSong: () => Promise<PublicState>
  previewPrev: () => Promise<PublicState>
  previewNext: () => Promise<PublicState>
  selectSong: (id: string | null) => Promise<PublicState>
  patchSettings: (patch: Partial<AppState>) => Promise<PublicState>
  refreshMidi: () => Promise<PublicState>
  arrangerPrev: () => Promise<PublicState>
  arrangerNext: () => Promise<PublicState>
  scanArranger: () => Promise<PublicState>
  cancelArrangerScan: () => Promise<PublicState>
  grabCubaseLength: () => Promise<PublicState>
  promptMidi: (pc: 120 | 121 | 122 | 123) => Promise<PublicState>
  ledMidiBlackout: () => Promise<PublicState>
  ledMidiIdle: () => Promise<PublicState>
  ledMidiApply: () => Promise<PublicState>
  previewLedPattern: (id: number) => Promise<PublicState>
  pickBackingTrack: (songId: string) => Promise<PublicState>
  analyzeSongLighting: (songId: string) => Promise<PublicState>
  analyzeAllLighting: () => Promise<PublicState>
  analyzeLightingFromCubase: () => Promise<PublicState>
  cancelLightingAnalyze: () => Promise<PublicState>
  setLightingProgram: (songId: string, program: unknown) => Promise<PublicState>
  listLoopbackDevices: () => Promise<string[]>
}

declare global {
  interface Window {
    viewer: ViewerApi
  }
}

export {}
