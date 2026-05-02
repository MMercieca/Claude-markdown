import { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage, SDKRateLimitInfo, Query } from '@anthropic-ai/claude-agent-sdk'
import type {
  LayoutState,
  EffortLevel,
  ModelOption,
  ConfigBootstrap,
  UsageState,
  AuthInfo,
  SignInStatus,
} from '../shared/ipc'

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
  activeQuery: boolean              // true while the agent is generating a response
  promptChannel: PromptChannel | null  // null until first send
  activeQueryObj: Query | null      // live Query for interrupt; null when idle
  cwd: string
  model: string
  effort: EffortLevel
  usage: UsageState                 // last-known usage; rate-limit fields persist across turns
}

const sessions = new Map<number, SessionState>()

// ── Defaults ────────────────────────────────────────────────────────────────
// cwd: $PWD if launched from a terminal, else $HOME.
// model/effort: read from ~/.claude/settings.json once at startup; SDK
// defaults if absent or malformed.

const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-7',          label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6',        label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const SDK_DEFAULT_MODEL = 'claude-opus-4-7'
const SDK_DEFAULT_EFFORT: EffortLevel = 'high'

function defaultCwd(): string {
  // Terminal launches inherit TERM and a meaningful PWD; Finder/launchd launches
  // don't set TERM. (Checking PWD !== app.getAppPath() doesn't work in dev,
  // where electron-vite makes them equal.)
  const pwd = process.env['PWD']
  if (pwd && pwd !== '/' && process.env['TERM']) return pwd
  return homedir()
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v)
}

interface UserSettings {
  model: string
  effort: EffortLevel
}

async function readUserSettings(): Promise<UserSettings> {
  try {
    const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return { model: SDK_DEFAULT_MODEL, effort: SDK_DEFAULT_EFFORT }
    }
    const obj = parsed as Record<string, unknown>
    return {
      model: typeof obj['model'] === 'string' ? obj['model'] : SDK_DEFAULT_MODEL,
      effort: isEffort(obj['effort']) ? obj['effort'] : SDK_DEFAULT_EFFORT,
    }
  } catch {
    return { model: SDK_DEFAULT_MODEL, effort: SDK_DEFAULT_EFFORT }
  }
}

let cachedUserSettings: UserSettings | null = null
async function getUserSettings(): Promise<UserSettings> {
  cachedUserSettings ??= await readUserSettings()
  return cachedUserSettings
}

// ── Usage tracking ──────────────────────────────────────────────────────────
// Rate-limit fields persist across turns (the SDK only re-emits them on change);
// context % is recomputed after every turn via q.getContextUsage().

function applyRateLimitEvent(session: SessionState, info: SDKRateLimitInfo): void {
  if (info.rateLimitType === undefined) return
  const status = info.status
  const pct = info.utilization !== undefined ? Math.round(info.utilization * 100) : undefined
  if (info.rateLimitType === 'five_hour') {
    session.usage.fiveHourStatus = status
    if (pct !== undefined) session.usage.fiveHourPct = pct
  } else if (
    info.rateLimitType === 'seven_day' ||
    info.rateLimitType === 'seven_day_opus' ||
    info.rateLimitType === 'seven_day_sonnet'
  ) {
    // Worst-of across the three 7d limits.
    const prevPct = session.usage.sevenDayPct ?? 0
    session.usage.sevenDayStatus = status
    if (pct !== undefined) session.usage.sevenDayPct = Math.max(prevPct, pct)
  }
}

// ── Persistent query loop ───────────────────────────────────────────────────
// Runs once per window, started on the first session:send.
// Streams deltas to the renderer; fires session:done after each assistant turn.

async function runQueryLoop(
  session: SessionState,
  win: BrowserWindow,
  channel: PromptChannel,
): Promise<void> {
  const q = query({
    prompt: channel,
    options: {
      includePartialMessages: true,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
    },
  })
  session.activeQueryObj = q

  // Detect auth mode once per session. Drives cost-chip visibility and the
  // auth chip in the status bar.
  let showCost = false
  try {
    const info = await q.accountInfo()
    const provider = info.apiProvider ?? 'firstParty'
    const isFirstParty = provider === 'firstParty'
    const isSubscription = isFirstParty && !!info.subscriptionType
    showCost = isFirstParty && !isSubscription

    let label: string
    if (isFirstParty) {
      label = isSubscription ? `claude-ai · ${info.subscriptionType}` : 'api-key'
    } else {
      label = provider  // 'bedrock', 'vertex', etc.
    }

    const authInfo: AuthInfo = { label, showCost }
    win.webContents.send('session:auth', authInfo)
    if (showCost) session.usage.costUsd = 0
  } catch (err) {
    console.warn('[session] accountInfo failed:', err)
    win.webContents.send('session:auth', { label: 'unknown', showCost: false })
  }

  try {
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
      } else if (msg.type === 'rate_limit_event') {
        applyRateLimitEvent(session, msg.rate_limit_info)
        win.webContents.send('session:usage', session.usage)
      } else if (msg.type === 'result') {
        // SDKResultMessage is the canonical end-of-turn marker in
        // streaming-input mode — it arrives after all stream_event deltas
        // for a turn. (The 'assistant' SDK message arrives before the
        // deltas, not after, so it can't be used to mark turn end.)
        if (showCost) {
          session.usage.costUsd = (session.usage.costUsd ?? 0) + msg.total_cost_usd
        }
        try {
          const ctx = await q.getContextUsage()
          session.usage.ctxPct = Math.round(ctx.percentage)
        } catch (err) {
          console.warn('[session] getContextUsage failed:', err)
        }
        win.webContents.send('session:usage', session.usage)
        if (session.activeQuery) {
          session.activeQuery = false
          win.webContents.send('session:done')
        }
      }
    }
  } catch (err) {
    console.error('[session] Query loop error:', err)
    if (!win.isDestroyed() && session.activeQuery) {
      session.activeQuery = false
      win.webContents.send('session:done')
    }
  } finally {
    session.activeQueryObj = null
  }
}

// ── Session interrupt handler ───────────────────────────────────────────────

ipcMain.handle('session:interrupt', async (event): Promise<void> => {
  const session = sessions.get(event.sender.id)
  if (!session?.activeQuery || !session.activeQueryObj) return

  await session.activeQueryObj.interrupt()

  // If the loop's assistant-message handler hasn't already sent session:done,
  // send it now so the renderer can re-enable input.
  if (session.activeQuery) {
    session.activeQuery = false
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.webContents.send('session:done')
  }
})

// ── Claude.ai OAuth sign-in handler ────────────────────────────────────────
// Starts an ephemeral query just to run the claudeAuthenticate + wait flow,
// then closes it. The resulting tokens are cached by the CLI for all future
// queries in this session.

// Runtime shape of the undocumented OAuth control methods on Query.
interface QueryWithOAuth {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ url?: string }>
  claudeOAuthWaitForCompletion(): Promise<void>
}

ipcMain.handle('session:signIn', async (event): Promise<void> => {
  const session = sessions.get(event.sender.id)
  if (!session) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  const sendStatus = (status: SignInStatus): void => {
    if (!win.isDestroyed()) win.webContents.send('session:signInStatus', status)
  }

  sendStatus({ inProgress: true })

  const authChannel = new PromptChannel()
  const q = query({
    prompt: authChannel,
    options: {
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
    },
  })

  try {
    const oauthQ = q as unknown as QueryWithOAuth
    const result = await oauthQ.claudeAuthenticate(true)
    const url = result?.url
    if (url) await shell.openExternal(url)

    await oauthQ.claudeOAuthWaitForCompletion()
    sendStatus({ inProgress: false })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    sendStatus({ inProgress: false, error })
  } finally {
    authChannel.close()
    q.close()
  }
})

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

// ── Config IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle('config:get', (event): ConfigBootstrap | null => {
  const session = sessions.get(event.sender.id)
  if (!session) return null
  return {
    cwd: session.cwd,
    model: session.model,
    effort: session.effort,
    models: AVAILABLE_MODELS,
    effortLevels: EFFORT_LEVELS,
  }
})

ipcMain.handle('config:pickCwd', async (event): Promise<string | null> => {
  const session = sessions.get(event.sender.id)
  if (!session) return null
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: session.cwd,
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const chosen = result.filePaths[0]!
  session.cwd = chosen
  return chosen
})

ipcMain.handle('config:setModel', (event, model: string): void => {
  const session = sessions.get(event.sender.id)
  if (!session) return
  session.model = model
})

ipcMain.handle('config:setEffort', (event, effort: EffortLevel): void => {
  const session = sessions.get(event.sender.id)
  if (!session) return
  session.effort = effort
})

// ── Window factory ──────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  const userSettings = await getUserSettings()
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
  sessions.set(sessionId, {
    windowId: sessionId,
    activeQuery: false,
    promptChannel: null,
    activeQueryObj: null,
    cwd: defaultCwd(),
    model: userSettings.model,
    effort: userSettings.effort,
    usage: {},
  })

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
  void createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
