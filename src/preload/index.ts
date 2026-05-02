import { contextBridge, ipcRenderer } from 'electron'
import type { LayoutState, ConfigBootstrap, EffortLevel, AuthMode, UsageState, AuthInfo, SignInStatus, AuthError } from '../shared/ipc'

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
    setAuthMode: (mode: AuthMode): Promise<void> =>
      ipcRenderer.invoke('config:setAuthMode', mode) as Promise<void>,
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

    onUsage: (cb: (usage: UsageState) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, usage: UsageState) => cb(usage)
      ipcRenderer.on('session:usage', listener)
      return () => ipcRenderer.removeListener('session:usage', listener)
    },

    onAuth: (cb: (auth: AuthInfo) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, auth: AuthInfo) => cb(auth)
      ipcRenderer.on('session:auth', listener)
      return () => ipcRenderer.removeListener('session:auth', listener)
    },

    signIn: (): Promise<void> =>
      ipcRenderer.invoke('session:signIn') as Promise<void>,

    onSignInStatus: (cb: (status: SignInStatus) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: SignInStatus) => cb(status)
      ipcRenderer.on('session:signInStatus', listener)
      return () => ipcRenderer.removeListener('session:signInStatus', listener)
    },

    onAuthError: (cb: (error: AuthError | null) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, error: AuthError | null) => cb(error)
      ipcRenderer.on('session:authError', listener)
      return () => ipcRenderer.removeListener('session:authError', listener)
    },
  },

  system: {
    openUrl: (url: string): Promise<void> =>
      ipcRenderer.invoke('system:openUrl', url) as Promise<void>,
  },
} as const

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
export type { LayoutState, ConfigBootstrap, EffortLevel, AuthMode, UsageState, AuthInfo, SignInStatus, AuthError }
