import { contextBridge, ipcRenderer } from 'electron'
import type { LayoutState, ConfigBootstrap, EffortLevel } from '../shared/ipc'

// Ergonomic nested API exposed to the renderer. Each method wraps
// ipcRenderer.invoke so the renderer never sees ipcRenderer directly.
// Channel names match the RendererToMain keys in src/shared/ipc.ts.
const api = {
  ping: (): Promise<'pong'> =>
    ipcRenderer.invoke('ping') as Promise<'pong'>,

  layout: {
    load: (): Promise<LayoutState | null> =>
      ipcRenderer.invoke('layout:load') as Promise<LayoutState | null>,
    save: (state: LayoutState): Promise<void> =>
      ipcRenderer.invoke('layout:save', state) as Promise<void>,
  },

  config: {
    get: (): Promise<ConfigBootstrap | null> =>
      ipcRenderer.invoke('config:get') as Promise<ConfigBootstrap | null>,
    pickCwd: (): Promise<string | null> =>
      ipcRenderer.invoke('config:pickCwd') as Promise<string | null>,
    setModel: (model: string): Promise<void> =>
      ipcRenderer.invoke('config:setModel', model) as Promise<void>,
    setEffort: (effort: EffortLevel): Promise<void> =>
      ipcRenderer.invoke('config:setEffort', effort) as Promise<void>,
  },

  session: {
    send: (text: string): Promise<void> =>
      ipcRenderer.invoke('session:send', text) as Promise<void>,

    interrupt: (): Promise<void> =>
      ipcRenderer.invoke('session:interrupt') as Promise<void>,

    onDelta: (cb: (delta: string) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, delta: string) => cb(delta)
      ipcRenderer.on('session:delta', listener)
      return () => ipcRenderer.removeListener('session:delta', listener)
    },

    onDone: (cb: () => void): (() => void) => {
      const listener = () => cb()
      ipcRenderer.on('session:done', listener)
      return () => ipcRenderer.removeListener('session:done', listener)
    },
  },
} as const

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
export type { LayoutState, ConfigBootstrap, EffortLevel }
