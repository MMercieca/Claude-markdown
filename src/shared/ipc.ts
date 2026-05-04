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

export type AuthMode = 'api-key' | 'claude-ai' | 'bedrock'

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
  authMode: AuthMode
  bedrockAvailable: boolean
}

export interface RendererToMain {
  ping(): 'pong'
  'layout:load'(): LayoutState | null
  'layout:save'(state: LayoutState): void
  'session:send'(text: string): void
  'session:sendContent'(text: string, images: SerializedImage[]): void
  'session:retry'(): void
  'session:interrupt'(): void
  'session:signIn'(): void
  'session:clear'(): void
  'session:setModel'(model: string): string | null  // null = success, string = error message
  'session:permissionResponse'(toolId: string, choice: PermissionChoice): void
  'config:get'(): ConfigBootstrap
  'config:pickCwd'(): string | null
  'config:setModel'(model: string): void
  'config:setEffort'(effort: EffortLevel): void
  'config:setAuthMode'(mode: AuthMode): void
  'config:reloadSettings'(): void
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface SerializedImage {
  mimeType: ImageMediaType
  base64Data: string
  width: number
  height: number
  dataUrl: string
}

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface UsageState {
  ctxPct?: number              // 0-100, context window utilization
  fiveHourPct?: number         // 0-100, 5-hour rate limit (absent when SDK omits utilization)
  fiveHourStatus?: RateLimitStatus
  sevenDayPct?: number         // 0-100, 7-day rate limit (worst of opus/sonnet/global)
  sevenDayStatus?: RateLimitStatus
  costUsd?: number             // accumulated session cost; undefined when subscription auth
}

export interface AuthInfo {
  /** Human-readable label, e.g. "api-key", "claude-ai · max", "bedrock" */
  label: string
  /** Whether to show the cost chip (false for subscription / Bedrock) */
  showCost: boolean
}

export interface SignInStatus {
  /** true while the OAuth flow is in progress */
  inProgress: boolean
  /** set on failure */
  error?: string
}

export interface AuthError {
  authMode: AuthMode
  /** human-readable description of what went wrong */
  message: string
}

export interface CompactionInfo {
  turnNum: number
  trigger: 'manual' | 'auto'
  preTokens: number
  postTokens?: number
}

export interface ConfigError {
  message: string
}

export interface BlockingError {
  message: string
  /** whether [Retry] should be shown */
  retryable: boolean
  /** ms timestamp of quota reset; drives countdown when present */
  quotaResetAt?: number
}

export interface TurnStats {
  inputTokens: number
  outputTokens: number
  /** wall-clock turn duration in milliseconds */
  durationMs: number
  /** model that serviced the turn */
  model: string
}

export type PermissionChoice = 'allow_once' | 'allow_session' | 'deny'

export interface PermissionRequest {
  toolId: string          // toolUseID from SDK
  toolName: string
  inputJson?: string      // pretty-printed tool input
  title?: string          // SDK-provided prompt sentence, e.g. "Claude wants to run npm test"
  description?: string    // SDK-provided subtitle
  hasSuggestions: boolean // whether SDK provided session-persistence suggestions
}

export type LogEventKind = 'turn_start' | 'tool_call' | 'tool_result' | 'assistant_text'

export interface LogEvent {
  kind: LogEventKind
  turnNum?: number    // turn_start
  toolName?: string   // tool_call
  toolId?: string     // tool_call | tool_result
  inputJson?: string  // tool_call: JSON.stringify(input, null, 2)
  outputText?: string // tool_result: extracted text content
  isError?: boolean   // tool_result
  isDenied?: boolean  // tool_result: user denied the permission request
  textLength?: number // assistant_text: character count
}

export interface MainToRenderer {
  'session:delta': string  // partial text delta while streaming
  'session:done': void     // query completed
  'session:usage': UsageState  // partial usage update; merge with prior state
  'session:auth': AuthInfo    // one-time auth mode signal after accountInfo() resolves
  'session:signInStatus': SignInStatus  // progress/result of claude.ai OAuth sign-in
  'session:authError': AuthError | null  // null = dismiss the banner
  'session:compaction': CompactionInfo
  'session:blockingError': BlockingError | null  // null = dismiss the banner
  'session:configError': ConfigError | null      // null = dismiss the banner
  'session:turnStats': TurnStats        // emitted with each result message
  'session:logEvent': LogEvent          // structured event for the right-pane log
  'session:permissionRequest': PermissionRequest  // tool permission required; agent paused
  'session:cleared': void               // session was reset via /clear; renderer should wipe state
}

export interface RendererToSystem {
  'system:openUrl'(url: string): void
}
