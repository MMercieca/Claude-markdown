/**
 * IPC channel type definitions shared between main and preload/renderer.
 *
 * RendererToMain: channels the renderer invokes (ipcRenderer.invoke /
 *   ipcMain.handle). Values are the synchronous return type; the preload
 *   wraps each in a Promise.
 *
 * MainToRenderer: channels main pushes to the renderer (ipcMain.send /
 *   ipcRenderer.on). Populated in later steps when streaming and permission
 *   events are added.
 */

export interface LayoutState {
  leftWidth: number
  promptHeight: number
}

export interface RendererToMain {
  ping(): 'pong'
  'layout:load'(): LayoutState | null
  'layout:save'(state: LayoutState): void
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MainToRenderer {}
