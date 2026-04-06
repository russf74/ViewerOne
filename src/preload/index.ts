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
  patchSettings: (patch: Partial<AppState>): Promise<PublicState> =>
    ipcRenderer.invoke('settings:patch', patch),
  refreshMidi: (): Promise<PublicState> => ipcRenderer.invoke('midi:refresh'),
  openDisplay: (): Promise<PublicState> => ipcRenderer.invoke('window:display:open'),
  hideDisplay: (): Promise<PublicState> => ipcRenderer.invoke('window:display:hide'),
  start: (): Promise<PublicState> => ipcRenderer.invoke('action:start'),
  stop: (): Promise<PublicState> => ipcRenderer.invoke('action:stop'),
  muteAll: (): Promise<PublicState> => ipcRenderer.invoke('action:muteAll'),
  muteFx: (): Promise<PublicState> => ipcRenderer.invoke('action:muteFx')
}

contextBridge.exposeInMainWorld('viewer', api)

export type ViewerApi = typeof api
