import { contextBridge, ipcRenderer } from 'electron'

export interface LayoutState {
  leftWidth: number
  promptHeight: number
}

const api = {
  layout: {
    load: (): Promise<LayoutState | null> =>
      ipcRenderer.invoke('layout:load') as Promise<LayoutState | null>,
    save: (state: LayoutState): Promise<void> =>
      ipcRenderer.invoke('layout:save', state) as Promise<void>,
  },
} as const

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
