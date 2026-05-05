import { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, Menu, MenuItem } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { exec, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { query, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage, SDKRateLimitInfo, Query, SDKAssistantMessage, SDKCompactBoundaryMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type {
  LayoutState,
  EffortLevel,
  AuthMode,
  ModelOption,
  ConfigBootstrap,
  UsageState,
  AuthInfo,
  SignInStatus,
  AuthError,
  BlockingError,
  ConfigError,
  CompactionInfo,
  TurnStats,
  LogEvent,
  PermissionRequest,
  PermissionChoice,
  SerializedImage,
  HistoricalTurn,
  SessionSummary,
} from '../shared/ipc'

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

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

  pushBlocks(blocks: ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      // The Anthropic API accepts content block arrays; SDK type declares string
      // but accepts arrays at runtime.
      message: { role: 'user', content: blocks as unknown as string },
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
  authMode: AuthMode
  turnNum: number                   // incremented on each session:send
  usage: UsageState                 // last-known usage; rate-limit fields persist across turns
  pendingPermissions: Map<string, (choice: PermissionChoice) => void>  // toolUseID → resolver
  deniedToolIds: Set<string>  // tools the user denied; used to suppress error styling
  lastSentText: string | null  // saved for retry after a blocking error
  claudeSessionId: string | null    // SDK session ID; null until first turn init message
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

function bedrockAvailable(): boolean {
  return process.env['CLAUDE_CODE_USE_BEDROCK'] === '1'
}

function defaultAuthMode(): AuthMode {
  if (bedrockAvailable()) return 'bedrock'
  if (process.env['ANTHROPIC_API_KEY']) return 'api-key'
  return 'claude-ai'
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v)
}

interface UserSettings {
  model: string
  effort: EffortLevel
  allowedTools: string[]  // from permissions.allow in ~/.claude/settings.json
  statusLine?: string     // optional shell command whose stdout is shown in the status bar
}

let cachedUserSettings: UserSettings | null = null
let cachedSettingsParseError: string | null = null

async function getUserSettings(): Promise<UserSettings> {
  if (cachedUserSettings !== null) return cachedUserSettings

  const defaults: UserSettings = { model: SDK_DEFAULT_MODEL, effort: SDK_DEFAULT_EFFORT, allowedTools: [] }
  let raw: string
  try {
    raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      cachedSettingsParseError = `Could not read ~/.claude/settings.json: ${err instanceof Error ? err.message : String(err)}`
    }
    cachedUserSettings = defaults
    return cachedUserSettings
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      cachedSettingsParseError = '~/.claude/settings.json is not a valid JSON object.'
      cachedUserSettings = defaults
      return cachedUserSettings
    }
    const obj = parsed as Record<string, unknown>
    const perms = obj['permissions'] as Record<string, unknown> | undefined
    const allowRaw = perms?.['allow']
    const allowedTools = Array.isArray(allowRaw)
      ? allowRaw.filter((x): x is string => typeof x === 'string')
      : []
    cachedSettingsParseError = null
    cachedUserSettings = {
      model: typeof obj['model'] === 'string' ? obj['model'] : SDK_DEFAULT_MODEL,
      effort: isEffort(obj['effort']) ? obj['effort'] : SDK_DEFAULT_EFFORT,
      allowedTools,
      statusLine: typeof obj['statusLine'] === 'string' ? obj['statusLine'] : undefined,
    }
    return cachedUserSettings
  } catch (err) {
    cachedSettingsParseError = `~/.claude/settings.json has invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    cachedUserSettings = defaults
    return cachedUserSettings
  }
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

// ── Log event helpers ───────────────────────────────────────────────────────
// The SDK strips tool_use blocks from SDKAssistantMessage.message.content
// before emitting, so tool calls must be captured from content_block_start
// stream events. Text blocks remain and are used for assistant_text chips.

function emitAssistantText(win: BrowserWindow, msg: SDKAssistantMessage): void {
  if (!Array.isArray(msg.message.content)) return
  for (const block of msg.message.content) {
    if (block.type === 'text' && block.text.trim()) {
      win.webContents.send('session:logEvent', {
        kind: 'assistant_text',
        textLength: block.text.length,
      } satisfies LogEvent)
    }
  }
}

function emitToolResults(win: BrowserWindow, msg: SDKUserMessage, deniedToolIds: Set<string>): void {
  const content = msg.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as unknown as Record<string, unknown>
    if (b['type'] !== 'tool_result') continue
    const toolId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : undefined
    const isDenied = toolId !== undefined && deniedToolIds.has(toolId)
    const outputText = typeof b['content'] === 'string'
      ? b['content']
      : Array.isArray(b['content'])
        ? (b['content'] as Array<{type?: string; text?: string}>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n')
        : ''
    const ev: LogEvent = {
      kind: 'tool_result',
      toolId,
      outputText,
      isError: !!b['is_error'] && !isDenied,
      isDenied,
    }
    win.webContents.send('session:logEvent', ev)
  }
}

// ── Tool permissions ────────────────────────────────────────────────────────

const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

function makeCanUseTool(
  session: SessionState,
  win: BrowserWindow,
  settingsAllowlist: Set<string>,
): CanUseTool {
  return async (toolName, input, opts) => {
    if (AUTO_ALLOW_TOOLS.has(toolName) || settingsAllowlist.has(toolName)) {
      return { behavior: 'allow' }
    }

    const { suggestions } = opts

    let resolvePermission!: (choice: PermissionChoice) => void
    const permissionPromise = new Promise<PermissionChoice>(resolve => { resolvePermission = resolve })
    session.pendingPermissions.set(opts.toolUseID, resolvePermission)

    opts.signal.addEventListener('abort', () => {
      if (session.pendingPermissions.delete(opts.toolUseID)) resolvePermission('deny')
    }, { once: true })

    let inputJson: string | undefined
    try { inputJson = JSON.stringify(input, null, 2) } catch { /* leave undefined */ }

    const req: PermissionRequest = {
      toolId: opts.toolUseID,
      toolName,
      inputJson,
      title: opts.title,
      description: opts.description,
      hasSuggestions: suggestions !== undefined && suggestions.length > 0,
    }
    win.webContents.send('session:permissionRequest', req)

    const choice = await permissionPromise
    session.pendingPermissions.delete(opts.toolUseID)

    if (choice === 'deny') {
      session.deniedToolIds.add(opts.toolUseID)
      return { behavior: 'deny', message: `Permission denied for ${toolName}.`, decisionClassification: 'user_reject' }
    }
    if (choice === 'allow_session' && suggestions !== undefined && suggestions.length > 0) {
      return { behavior: 'allow', updatedPermissions: suggestions, decisionClassification: 'user_permanent' }
    }
    return { behavior: 'allow', decisionClassification: 'user_temporary' }
  }
}

// ── Error classification ────────────────────────────────────────────────────

function classifyBlockingError(err: unknown): BlockingError {
  const e = err as { status?: number; message?: string; headers?: { get?: (k: string) => string | null } }
  const message = e.message ?? String(err)
  const status = e.status

  if (status === 429) {
    let quotaResetAt: number | undefined
    try {
      const retryAfter = e.headers?.get?.('retry-after')
      if (retryAfter) {
        const secs = parseFloat(retryAfter)
        if (!isNaN(secs) && secs > 0) quotaResetAt = Date.now() + secs * 1000
      }
    } catch { /* ignore */ }
    return {
      message: 'Rate limit reached. Please wait before retrying.',
      retryable: quotaResetAt === undefined,
      quotaResetAt,
    }
  }

  if (status !== undefined && status >= 500) {
    return { message: `Server error (${status}): ${message}`, retryable: true }
  }

  if (status !== undefined && status >= 400) {
    return { message: `API error (${status}): ${message}`, retryable: false }
  }

  return { message: `Connection error: ${message}`, retryable: true }
}

// ── Persistent query loop ───────────────────────────────────────────────────
// Runs once per window, started on the first session:send.
// Streams deltas to the renderer; fires session:done after each assistant turn.

async function runQueryLoop(
  session: SessionState,
  win: BrowserWindow,
  channel: PromptChannel,
): Promise<void> {
  const userSettings = await getUserSettings()
  if (cachedSettingsParseError) {
    win.webContents.send('session:configError', { message: cachedSettingsParseError } satisfies ConfigError)
  }
  const settingsAllowlist = new Set(userSettings.allowedTools)
  const q = query({
    prompt: channel,
    options: {
      includePartialMessages: true,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      settingSources: ['user', 'project', 'local'],
      canUseTool: makeCanUseTool(session, win, settingsAllowlist),
      resume: session.claudeSessionId ?? undefined,
      onElicitation: async (request) => {
        if (request.mode === 'url' && request.url) {
          await shell.openExternal(request.url)
          return { action: 'accept' }
        }
        return { action: 'decline' }
      },
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
    const authError: AuthError = {
      authMode: session.authMode,
      message: 'Authentication failed. Please check your credentials.',
    }
    win.webContents.send('session:authError', authError)
  }

  // Per-block accumulator for streaming tool inputs.
  // Key = content block index; cleared when the block stops or the turn ends.
  const pendingToolCalls = new Map<number, { toolId: string; toolName: string; inputAccum: string }>()

  try {
    for await (const msg of q) {
      if (win.isDestroyed()) break

      if (msg.type === 'assistant' && msg.error === 'authentication_failed') {
        const authError: AuthError = {
          authMode: session.authMode,
          message: 'Authentication failed during the session.',
        }
        win.webContents.send('session:authError', authError)
      } else if (msg.type === 'assistant' && !msg.error) {
        emitAssistantText(win, msg)
      } else if (msg.type === 'user' && msg.parent_tool_use_id !== null) {
        emitToolResults(win, msg, session.deniedToolIds)
      } else if (msg.type === 'stream_event') {
        const { event: streamEvent } = msg
        if (streamEvent.type === 'content_block_start') {
          const cb = streamEvent.content_block
          if (cb.type === 'tool_use' || cb.type === 'mcp_tool_use') {
            pendingToolCalls.set(streamEvent.index, {
              toolId: cb.id,
              toolName: cb.name,
              inputAccum: '',
            })
          }
        } else if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            win.webContents.send('session:delta', streamEvent.delta.text)
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const pending = pendingToolCalls.get(streamEvent.index)
            if (pending) pending.inputAccum += streamEvent.delta.partial_json
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const pending = pendingToolCalls.get(streamEvent.index)
          if (pending) {
            pendingToolCalls.delete(streamEvent.index)
            let inputJson = '{}'
            try {
              const parsed: unknown = JSON.parse(pending.inputAccum || '{}')
              inputJson = JSON.stringify(parsed, null, 2)
            } catch { /* leave as '{}' */ }
            win.webContents.send('session:logEvent', {
              kind: 'tool_call',
              toolName: pending.toolName,
              toolId: pending.toolId,
              inputJson,
            } satisfies LogEvent)
          }
        }
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        const initMsg = msg as { slash_commands?: unknown; session_id?: string }
        if (typeof initMsg.session_id === 'string') {
          session.claudeSessionId = initMsg.session_id
          const entry = windowAppStates.get(session.windowId)
          if (entry) {
            entry.sessionId = initMsg.session_id
            entry.lastActiveAt = new Date().toISOString()
            syncAndSave()
          }
        }
        if (Array.isArray(initMsg.slash_commands)) {
          const cmds = (initMsg.slash_commands as unknown[]).filter((c): c is string => typeof c === 'string')
          win.webContents.send('session:slashCommands', cmds)
        }
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const cm = msg as SDKCompactBoundaryMessage
        const info: CompactionInfo = {
          turnNum: session.turnNum,
          trigger: cm.compact_metadata.trigger,
          preTokens: cm.compact_metadata.pre_tokens,
          postTokens: cm.compact_metadata.post_tokens,
        }
        win.webContents.send('session:compaction', info)
        try {
          const ctx = await q.getContextUsage()
          session.usage.ctxPct = Math.round(ctx.percentage)
          win.webContents.send('session:usage', session.usage)
        } catch { /* ignore */ }
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
        pendingToolCalls.clear()
        win.webContents.send('session:usage', session.usage)
        const turnStats: TurnStats = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          durationMs: msg.duration_ms,
          model: session.model,
        }
        win.webContents.send('session:turnStats', turnStats)
        const winEntry = windowAppStates.get(session.windowId)
        if (winEntry) {
          winEntry.lastActiveAt = new Date().toISOString()
          syncAndSave()
        }
        if (session.activeQuery) {
          session.activeQuery = false
          win.webContents.send('session:done')
        }
      }
    }
  } catch (err) {
    console.error('[session] Query loop error:', err)
    if (!win.isDestroyed()) {
      const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      const isHookError = errMsg.includes('hook')
      if (isHookError) {
        const msg = err instanceof Error ? err.message : String(err)
        win.webContents.send('session:configError', { message: `Hook failure: ${msg}` } satisfies ConfigError)
      } else {
        win.webContents.send('session:blockingError', classifyBlockingError(err))
      }
      if (session.activeQuery) {
        session.activeQuery = false
        win.webContents.send('session:done')
      }
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

// ── Session setModel handler ────────────────────────────────────────────────

ipcMain.handle('session:setModel', async (event, model: string): Promise<string | null> => {
  const session = sessions.get(event.sender.id)
  if (!session) return 'No session found.'
  try {
    if (session.activeQueryObj) {
      await session.activeQueryObj.setModel(model)
    }
    session.model = model
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
})

// ── Session clear handler ───────────────────────────────────────────────────

ipcMain.handle('session:clear', async (event): Promise<void> => {
  const winId = event.sender.id
  const session = sessions.get(winId)
  if (!session) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  // Interrupt active query if any
  if (session.activeQuery && session.activeQueryObj) {
    await session.activeQueryObj.interrupt()
  }

  // Deny all pending permission prompts
  for (const [, resolver] of session.pendingPermissions) resolver('deny')

  // Close the prompt channel so the running query loop exits
  session.promptChannel?.close()

  // Reset runtime state; preserve window-level config (cwd, model, effort, authMode).
  // claudeSessionId is nulled so the next query starts a fresh session rather than
  // resuming the cleared one. The old JSONL stays on disk and is reachable via Cmd+O.
  session.activeQuery = false
  session.promptChannel = null
  session.activeQueryObj = null
  session.turnNum = 0
  session.usage = {}
  session.pendingPermissions = new Map()
  session.deniedToolIds = new Set()
  session.lastSentText = null
  session.claudeSessionId = null

  const entry = windowAppStates.get(session.windowId)
  if (entry) {
    entry.sessionId = null
    entry.lastActiveAt = new Date().toISOString()
    syncAndSave()
  }

  win.webContents.send('session:cleared')
})

// ── Permission response handler ─────────────────────────────────────────────

ipcMain.handle('session:permissionResponse', (event, toolId: string, choice: PermissionChoice): void => {
  const session = sessions.get(event.sender.id)
  if (!session) return
  const resolver = session.pendingPermissions.get(toolId)
  if (resolver) {
    session.pendingPermissions.delete(toolId)
    resolver(choice)
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
  session.turnNum++
  const turnStartEvent: LogEvent = { kind: 'turn_start', turnNum: session.turnNum }
  win.webContents.send('session:logEvent', turnStartEvent)

  if (session.promptChannel === null) {
    const channel = new PromptChannel()
    session.promptChannel = channel
    void runQueryLoop(session, win, channel)
  }

  session.lastSentText = text
  session.promptChannel.push(text)
})

// ── Session sendContent handler ─────────────────────────────────────────────

ipcMain.handle('session:sendContent', (event, text: string, images: SerializedImage[]): void => {
  const winId = event.sender.id
  const session = sessions.get(winId)
  if (!session || session.activeQuery) return

  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  session.activeQuery = true
  session.turnNum++
  const turnStartEvent: LogEvent = { kind: 'turn_start', turnNum: session.turnNum }
  win.webContents.send('session:logEvent', turnStartEvent)

  if (session.promptChannel === null) {
    const channel = new PromptChannel()
    session.promptChannel = channel
    void runQueryLoop(session, win, channel)
  }

  const blocks: ContentBlock[] = [
    ...images.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mimeType, data: img.base64Data },
    })),
  ]
  const trimmed = text.trim()
  if (trimmed) blocks.push({ type: 'text', text: trimmed })

  session.lastSentText = trimmed || null
  session.promptChannel.pushBlocks(blocks)
})

// ── Session retry handler ───────────────────────────────────────────────────

ipcMain.handle('session:retry', async (event): Promise<void> => {
  const winId = event.sender.id
  const session = sessions.get(winId)
  if (!session) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  const textToRetry = session.lastSentText

  // Deny pending permissions; close the (dead) channel
  for (const [, resolver] of session.pendingPermissions) resolver('deny')
  session.promptChannel?.close()

  // Reset session state
  session.activeQuery = false
  session.promptChannel = null
  session.activeQueryObj = null
  session.turnNum = 0
  session.usage = {}
  session.pendingPermissions = new Map()
  session.deniedToolIds = new Set()
  session.lastSentText = null

  win.webContents.send('session:cleared')

  if (textToRetry) {
    session.activeQuery = true
    session.turnNum++
    win.webContents.send('session:logEvent', { kind: 'turn_start', turnNum: session.turnNum } satisfies LogEvent)
    const channel = new PromptChannel()
    session.promptChannel = channel
    void runQueryLoop(session, win, channel)
    session.lastSentText = textToRetry
    channel.push(textToRetry)
  } else {
    win.webContents.send('session:done')
  }
})

// ── System IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle('system:openUrl', async (_event, url: string): Promise<void> => {
  await shell.openExternal(url)
})

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('ping', (): 'pong' => 'pong')

const layoutDir = join(homedir(), '.claude-markdown')
const layoutPath = join(layoutDir, 'layout.json')
const statePath = join(layoutDir, 'state.json')

// ── App state schema ────────────────────────────────────────────────────────

interface AppStateWindow {
  cwd: string
  sessionId: string | null
  lastActiveAt: string
  title: string | null
}

interface AppState {
  windows: AppStateWindow[]
  layoutVersion: number
}

const DEFAULT_APP_STATE: AppState = { windows: [], layoutVersion: 1 }
let appState: AppState = { ...DEFAULT_APP_STATE }
let stateSaveTimer: ReturnType<typeof setTimeout> | null = null

async function loadState(): Promise<AppState> {
  try {
    const raw = await readFile(statePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'windows' in parsed &&
      Array.isArray((parsed as Record<string, unknown>)['windows'])
    ) {
      appState = parsed as AppState
      return appState
    }
    console.warn('[state] state.json has unexpected shape; using default')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      console.warn('[state] Could not read state.json; using default:', err)
    }
  }
  appState = { ...DEFAULT_APP_STATE, windows: [] }
  return appState
}

function saveState(): void {
  if (stateSaveTimer !== null) clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null
    void (async () => {
      try {
        await mkdir(layoutDir, { recursive: true })
        await writeFile(statePath, JSON.stringify(appState, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[state] Could not save state.json:', err)
      }
    })()
  }, 500)
}

// In-memory per-window persistent state, keyed by Electron webContents.id.
// On save, the values are written as the `windows` array in state.json.
const windowAppStates = new Map<number, AppStateWindow>()

function syncAndSave(): void {
  appState.windows = Array.from(windowAppStates.values())
  saveState()
}

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
    authMode: session.authMode,
    bedrockAvailable: bedrockAvailable(),
    resumedSessionId: session.claudeSessionId ?? undefined,
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

ipcMain.handle('config:setAuthMode', (event, mode: AuthMode): void => {
  const session = sessions.get(event.sender.id)
  if (!session) return
  session.authMode = mode
})

ipcMain.handle('config:reloadSettings', async (event): Promise<void> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  cachedUserSettings = null
  cachedSettingsParseError = null
  await getUserSettings()
  if (!win.isDestroyed()) {
    win.webContents.send('session:configError',
      cachedSettingsParseError ? ({ message: cachedSettingsParseError } satisfies ConfigError) : null
    )
  }
})

// ── Session history hydration ──────────────────────────────────────────────
// Called by the renderer once on mount when the window was restored from a
// prior session. Returns prior user/assistant text turns in conversation order.

ipcMain.handle('session:getHistory', async (event): Promise<HistoricalTurn[]> => {
  const session = sessions.get(event.sender.id)
  if (!session?.claudeSessionId) return []

  try {
    const messages = await getSessionMessages(session.claudeSessionId, { dir: session.cwd })
    const turns: HistoricalTurn[] = []

    for (const msg of messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue
      const raw = msg.message as { role: string; content: unknown }
      const content = raw.content

      // Skip user messages whose content is entirely tool_result blocks — those
      // are SDK-internal feedback, not user-visible prompts.
      if (msg.type === 'user' && Array.isArray(content)) {
        const blocks = content as Array<{ type: string }>
        if (blocks.length > 0 && blocks.every(b => b.type === 'tool_result')) continue
      }

      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = (content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text!)
          .join('\n\n')
      }

      if (!text.trim()) continue
      turns.push({ role: msg.type as 'user' | 'assistant', text })
    }

    return turns
  } catch (err) {
    console.warn('[history] getSessionMessages failed:', err)
    return []
  }
})

// ── Session list and resume ──────────────────────────────────────────────────

ipcMain.handle('session:listSessions', async (event): Promise<SessionSummary[]> => {
  const session = sessions.get(event.sender.id)
  if (!session) return []

  try {
    const list = await listSessions({ dir: session.cwd })
    return list.map(s => ({
      sessionId: s.sessionId,
      summary: s.customTitle ?? s.summary,
      firstPrompt: s.firstPrompt,
      lastModified: s.lastModified,
      isCurrentSession: s.sessionId === session.claudeSessionId,
    }))
  } catch (err) {
    console.warn('[sessions] listSessions failed:', err)
    return []
  }
})

ipcMain.handle('session:resumeSession', async (event, sessionId: string): Promise<void> => {
  const winId = event.sender.id
  const session = sessions.get(winId)
  if (!session) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  if (session.activeQuery && session.activeQueryObj) {
    await session.activeQueryObj.interrupt()
  }

  for (const [, resolver] of session.pendingPermissions) resolver('deny')
  session.promptChannel?.close()

  session.activeQuery = false
  session.promptChannel = null
  session.activeQueryObj = null
  session.turnNum = 0
  session.usage = {}
  session.pendingPermissions = new Map()
  session.deniedToolIds = new Set()
  session.lastSentText = null
  session.claudeSessionId = sessionId

  const entry = windowAppStates.get(session.windowId)
  if (entry) {
    entry.sessionId = sessionId
    entry.lastActiveAt = new Date().toISOString()
    syncAndSave()
  }

  win.webContents.send('session:cleared')
})

// ── CLI slash-command shell-out ─────────────────────────────────────────────
// Handles CLI-only slash commands (e.g. /insights) that the SDK cannot dispatch
// headlessly. Spawns `claude --print <cmd>`, buffers stdout, returns the result.
// Binary resolved from PATH; ENOENT produces a clear error message.

ipcMain.handle('session:shellSlash', async (_event, cmd: string): Promise<{ output: string; error?: string }> => {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', cmd], {
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code) => {
      const out = stdout.trim()
      if (code === 0 || out) {
        resolve({ output: out })
      } else {
        resolve({ output: '', error: stderr.trim() || `claude exited with code ${String(code)}` })
      }
    })
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ output: '', error: 'claude CLI not found on PATH. Make sure it is installed and your PATH includes it.' })
      } else {
        resolve({ output: '', error: err.message })
      }
    })
  })
})

// ── Status-line shell-out ───────────────────────────────────────────────────
// Opt-in via `statusLine` key in ~/.claude/settings.json. Runs the command
// every 5 s and broadcasts trimmed stdout to every open window.

function startStatusLinePolling(cmd: string): void {
  const run = (): void => {
    exec(cmd, { timeout: 4000 }, (_err, stdout) => {
      const text = stdout.trim()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('session:statusLine', text)
      }
    })
  }
  run()
  setInterval(run, 5000)
}

// ── Application menu ────────────────────────────────────────────────────────
// Sets up the macOS application menu with New Window in the Window submenu.
// role:'windowMenu' causes Electron to call [NSApp setWindowsMenu:] so macOS
// automatically appends the open-window list and Cmd+` cycling.

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' as const },
    { role: 'windowMenu' as const },
  ]

  const menu = Menu.buildFromTemplate(template)

  const windowItem = menu.items.find(item => item.role === 'windowMenu' || item.label === 'Window')
  if (windowItem?.submenu) {
    // role:'windowMenu' omits Close (Cmd+W) on macOS — it lives in fileMenu.
    // Without a registered accelerator, Chromium swallows Cmd+W when the editor
    // has focus. Insert both items so the accelerator is owned by Electron's
    // menu system and takes priority over the web content.
    windowItem.submenu.insert(0, new MenuItem({ type: 'separator' }))
    windowItem.submenu.insert(0, new MenuItem({ role: 'close' }))
    windowItem.submenu.insert(0, new MenuItem({ type: 'separator' }))
    windowItem.submenu.insert(0, new MenuItem({
      label: 'New Window',
      accelerator: 'CmdOrCtrl+N',
      click: () => { void createWindow() },
    }))
  }

  Menu.setApplicationMenu(menu)
}

// ── Window factory ──────────────────────────────────────────────────────────

async function createWindow(opts?: { cwd?: string; resumeSessionId?: string }): Promise<void> {
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
  const windowCwd = opts?.cwd ?? defaultCwd()
  const initialClaudeSessionId = opts?.resumeSessionId ?? null
  sessions.set(sessionId, {
    windowId: sessionId,
    activeQuery: false,
    promptChannel: null,
    activeQueryObj: null,
    cwd: windowCwd,
    model: userSettings.model,
    effort: userSettings.effort,
    authMode: defaultAuthMode(),
    turnNum: 0,
    usage: {},
    pendingPermissions: new Map(),
    deniedToolIds: new Set(),
    lastSentText: null,
    claudeSessionId: initialClaudeSessionId,
  })

  windowAppStates.set(sessionId, {
    cwd: windowCwd,
    sessionId: initialClaudeSessionId,
    lastActiveAt: new Date().toISOString(),
    title: null,
  })
  syncAndSave()

  win.on('close', () => {
    const session = sessions.get(sessionId)
    if (session?.activeQuery && session.activeQueryObj) {
      void session.activeQueryObj.interrupt()
    }
    session?.promptChannel?.close()
  })

  win.on('closed', () => {
    sessions.delete(sessionId)
    windowAppStates.delete(sessionId)
    syncAndSave()
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

void app.whenReady().then(async () => {
  buildAppMenu()
  const settings = await getUserSettings()
  if (settings.statusLine) startStatusLinePolling(settings.statusLine)
  await loadState()
  const savedWindows = appState.windows
  if (savedWindows.length > 0) {
    for (const w of savedWindows) {
      void createWindow({ cwd: w.cwd, resumeSessionId: w.sessionId ?? undefined })
    }
  } else {
    void createWindow()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
