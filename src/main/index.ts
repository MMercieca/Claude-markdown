import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LayoutState } from '../shared/ipc'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Prompt channel ──────────────────────────────────────────────────────────
// An async iterable that lets the IPC handler push user messages into the
// persistent query loop one at a time. close() terminates the generator so
// the query loop exits cleanly when a window closes.

class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private waiters: Array<() => void> = []
  private _closed = false

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
    this.waiters.shift()?.()
  }

  close(): void {
    this._closed = true
    for (const w of this.waiters) w()
    this.waiters = []
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this._closed || this.queue.length > 0) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else {
        await new Promise<void>(resolve => this.waiters.push(resolve))
      }
    }
  }
}

// ── Per-window session state ────────────────────────────────────────────────
// Keyed by webContents.id, which equals event.sender.id in every IPC handler.

interface SessionState {
  windowId: number
  activeQuery: boolean          // true while the agent is generating a response
  promptChannel: PromptChannel | null  // null until first send
  // settings (cwd, model, effort) added in step 18
}

const sessions = new Map<number, SessionState>()

// ── Persistent query loop ───────────────────────────────────────────────────
// Runs once per window, started on the first session:send.
// Streams deltas to the renderer; fires session:done after each assistant turn.

async function runQueryLoop(
  session: SessionState,
  win: BrowserWindow,
  channel: PromptChannel,
): Promise<void> {
  try {
    const q = query({ prompt: channel, options: { includePartialMessages: true } })
    for await (const msg of q) {
      if (win.isDestroyed()) break

      if (msg.type === 'stream_event') {
        const { event: streamEvent } = msg
        if (
          streamEvent.type === 'content_block_delta' &&
          streamEvent.delta.type === 'text_delta'
        ) {
          win.webContents.send('session:delta', streamEvent.delta.text)
        }
      } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        // Top-level assistant turn complete — renderer may send the next prompt
        session.activeQuery = false
        win.webContents.send('session:done')
      }
    }
  } catch (err) {
    console.error('[session] Query loop error:', err)
    if (!win.isDestroyed()) {
      session.activeQuery = false
      win.webContents.send('session:done')
    }
  }
}

// ── Session send handler ────────────────────────────────────────────────────

ipcMain.handle('session:send', (event, text: string): void => {
  const winId = event.sender.id
  const session = sessions.get(winId)
  if (!session || session.activeQuery) return

  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  session.activeQuery = true

  if (session.promptChannel === null) {
    const channel = new PromptChannel()
    session.promptChannel = channel
    void runQueryLoop(session, win, channel)
  }

  session.promptChannel.push(text)
})

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('ping', (): 'pong' => 'pong')

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
  sessions.set(sessionId, { windowId: sessionId, activeQuery: false, promptChannel: null })

  win.on('closed', () => {
    sessions.get(sessionId)?.promptChannel?.close()
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
