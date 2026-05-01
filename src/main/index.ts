import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { LayoutState } from '../shared/ipc'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Per-window session state ────────────────────────────────────────────────
// Keyed by webContents.id, which equals event.sender.id in every IPC handler.
// All future per-window IPC handlers look up their session via this map.

interface SessionState {
  windowId: number
  // sdk query added in step 8
  // transcript added in step 9 / 14
  // settings (cwd, model, effort) added in step 18
}

const sessions = new Map<number, SessionState>()

// ── IPC handlers ────────────────────────────────────────────────────────────
// Channel names must match RendererToMain keys in src/shared/ipc.ts.

ipcMain.handle('ping', (): 'pong' => 'pong')

// Layout channels are global (one shared layout file); not per-window.

const layoutDir = join(homedir(), '.claude-markdown')
const layoutPath = join(layoutDir, 'layout.json')

ipcMain.handle('layout:load', async (): Promise<LayoutState | null> => {
  try {
    const raw = await readFile(layoutPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return parsed as LayoutState
  } catch {
    return null
  }
})

ipcMain.handle('layout:save', async (_event, state: LayoutState): Promise<void> => {
  await mkdir(layoutDir, { recursive: true })
  await writeFile(layoutPath, JSON.stringify(state), 'utf-8')
})

// ── Window factory ──────────────────────────────────────────────────────────

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'Claude Markdown',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const sessionId = win.webContents.id
  sessions.set(sessionId, { windowId: sessionId })

  win.on('closed', () => {
    sessions.delete(sessionId)
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
