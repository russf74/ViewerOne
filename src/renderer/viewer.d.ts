import type { AppState, PublicState, SetlistItem } from '../shared/types'

export type ViewerApi = {
  getState: () => Promise<PublicState>
  onState: (fn: (s: PublicState) => void) => () => void
  setSetlist: (items: SetlistItem[]) => Promise<PublicState>
  addSong: () => Promise<PublicState>
  removeSong: (id: string) => Promise<PublicState>
  prevSong: () => Promise<PublicState>
  nextSong: () => Promise<PublicState>
  patchSettings: (patch: Partial<AppState>) => Promise<PublicState>
  refreshMidi: () => Promise<PublicState>
  openDisplay: () => Promise<PublicState>
  hideDisplay: () => Promise<PublicState>
  start: () => Promise<PublicState>
  stop: () => Promise<PublicState>
  muteAll: () => Promise<PublicState>
  muteFx: () => Promise<PublicState>
}

declare global {
  interface Window {
    viewer: ViewerApi
  }
}

export {}
