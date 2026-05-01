import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { LayoutState } from '../preload/index'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

function createWindow(): void {
  const window = new BrowserWindow({
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

  window.on('ready-to-show', () => {
    window.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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
