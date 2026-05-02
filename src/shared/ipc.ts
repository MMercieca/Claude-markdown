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
  'session:signIn'(): void
  'config:get'(): ConfigBootstrap
  'config:pickCwd'(): string | null
  'config:setModel'(model: string): void
  'config:setEffort'(effort: EffortLevel): void
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

export interface MainToRenderer {
  'session:delta': string  // partial text delta while streaming
  'session:done': void     // query completed
  'session:usage': UsageState  // partial usage update; merge with prior state
  'session:auth': AuthInfo    // one-time auth mode signal after accountInfo() resolves
  'session:signInStatus': SignInStatus  // progress/result of claude.ai OAuth sign-in
}
