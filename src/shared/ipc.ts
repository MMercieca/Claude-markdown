/**
 * IPC channel type definitions shared between main and preload/renderer.
 *
 * RendererToMain: channels the renderer invokes (ipcRenderer.invoke /
 *   ipcMain.handle). Values are the synchronous return type; the preload
 *   wraps each in a Promise.
 *
 * MainToRenderer: channels main sends to the renderer (webContents.send /
 *   ipcRenderer.on). Values are the event payload type.
 */

export interface LayoutState {
  leftWidth: number
  promptHeight: number
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelOption {
  id: string
  label: string
}

export interface SessionConfig {
  cwd: string
  model: string
  effort: EffortLevel
}

export interface ConfigBootstrap extends SessionConfig {
  models: ModelOption[]
  effortLevels: EffortLevel[]
}

export interface RendererToMain {
  ping(): 'pong'
  'layout:load'(): LayoutState | null
  'layout:save'(state: LayoutState): void
  'session:send'(text: string): void
  'session:interrupt'(): void
  'config:get'(): ConfigBootstrap
  'config:pickCwd'(): string | null
  'config:setModel'(model: string): void
  'config:setEffort'(effort: EffortLevel): void
}

export interface MainToRenderer {
  'session:delta': string  // partial text delta while streaming
  'session:done': void     // query completed
}
