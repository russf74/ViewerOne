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
  listEsp32Ports: () => Promise<{ path: string; friendly?: string }[]>
}

declare global {
  interface Window {
    viewer: ViewerApi
  }
}

export {}
