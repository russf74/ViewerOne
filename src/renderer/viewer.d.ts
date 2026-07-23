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
  ledMidiIdle: () => Promise<PublicState>
  ledMidiApply: () => Promise<PublicState>
  previewLedPattern: (id: number) => Promise<PublicState>
}

declare global {
  interface Window {
    viewer: ViewerApi
  }
}

export {}
