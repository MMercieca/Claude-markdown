import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { AuthError, BlockingError, ConfigError, CompactionInfo, SerializedImage } from '../../shared/ipc'

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const onCopy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const text = preRef.current?.textContent ?? ''
    e.currentTarget.blur()
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="code-block-wrap">
      <button type="button" className="code-copy-btn" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  )
}

const markdownComponents: Components = { pre: CodeBlock }

// ── Tool chips ──────────────────────────────────────────────────────────────

export type ToolChip = {
  toolId: string
  label: string
  status: 'pending' | 'ok' | 'error' | 'denied'
}

function ToolChipEl({ chip }: { chip: ToolChip }): React.JSX.Element {
  const onClick = (): void => {
    const card = document.querySelector<HTMLElement>(`[data-tool-id="${chip.toolId}"]`)
    if (!card) return
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const body = card.querySelector<HTMLElement>('.rl-card-body')
    const btn = card.querySelector<HTMLButtonElement>('.rl-expand-btn')
    if (body?.hidden) {
      body.hidden = false
      if (btn) {
        btn.textContent = '▼'
        btn.setAttribute('aria-expanded', 'true')
      }
    }
  }

  const statusIcon = chip.status === 'pending' ? '…' : chip.status === 'ok' ? '✓' : '✗'
  return (
    <button
      type="button"
      className={`tool-chip tool-chip-${chip.status}`}
      onClick={onClick}
      title="Click to expand in right pane"
    >
      <span className="tool-chip-icon">⚙</span>
      <span className="tool-chip-label">{chip.label}</span>
      <span className="tool-chip-status">{statusIcon}</span>
    </button>
  )
}

// ── Turn types ──────────────────────────────────────────────────────────────

export type TurnSegment =
  | { kind: 'text'; content: string }
  | { kind: 'chip'; chip: ToolChip }

export type Turn =
  | { role: 'user'; text: string; images?: SerializedImage[] }
  | { role: 'assistant'; segments: TurnSegment[]; interrupted?: boolean }
  | { role: 'system'; markdown: string }
  | { role: 'compaction'; turnNum: number; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }

// ── Helpers ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_DOCS = 'https://docs.anthropic.com/en/api/getting-started'

function AuthBanner({ error, onDismiss }: { error: AuthError; onDismiss: () => void }): React.JSX.Element {
  const actions: React.JSX.Element[] = []

  if (error.authMode === 'claude-ai') {
    actions.push(
      <button key="signin" className="auth-banner-action" type="button"
        onClick={() => { void window.api.session.signIn(); onDismiss() }}>
        Sign in
      </button>
    )
  } else if (error.authMode === 'api-key') {
    actions.push(
      <button key="docs" className="auth-banner-action" type="button"
        onClick={() => void window.api.system.openUrl(ANTHROPIC_API_DOCS)}>
        API key docs ↗
      </button>
    )
  } else if (error.authMode === 'bedrock') {
    actions.push(
      <span key="bedrock-hint" className="auth-banner-hint">
        Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
      </span>
    )
  }

  actions.push(
    <button key="dismiss" className="auth-banner-dismiss" type="button" onClick={onDismiss}>
      Dismiss
    </button>
  )

  return (
    <div className="auth-banner" role="alert">
      <span className="auth-banner-msg">{error.message}</span>
      <span className="auth-banner-actions">{actions}</span>
    </div>
  )
}

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function BlockingErrorBanner({
  error,
  onDismiss,
  onRetry,
}: {
  error: BlockingError
  onDismiss: () => void
  onRetry: () => void
}): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(
    error.quotaResetAt !== undefined
      ? Math.max(0, Math.ceil((error.quotaResetAt - Date.now()) / 1000))
      : null
  )

  useEffect(() => {
    if (error.quotaResetAt === undefined) return
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((error.quotaResetAt! - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [error.quotaResetAt])

  const canRetry = error.retryable || (secondsLeft !== null && secondsLeft <= 0)
  const displayMessage =
    secondsLeft !== null && secondsLeft > 0
      ? `${error.message} Resets in ${formatCountdown(secondsLeft)}.`
      : error.message

  return (
    <div className="blocking-error-banner" role="alert">
      <span className="blocking-error-msg">{displayMessage}</span>
      <span className="blocking-error-actions">
        {canRetry && (
          <button className="blocking-error-action" type="button" onClick={onRetry}>
            Retry
          </button>
        )}
        <button className="blocking-error-dismiss" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  )
}

function ConfigErrorBanner({
  error,
  onDismiss,
}: {
  error: ConfigError
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="config-error-banner" role="alert">
      <span className="config-error-msg">{error.message}</span>
      <span className="config-error-actions">
        <button
          className="config-error-reload-btn"
          type="button"
          onClick={() => void window.api.config.reloadSettings()}
        >
          Reload settings
        </button>
        <button className="config-error-dismiss" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function compactionLabel(trigger: string, preTokens: number, postTokens?: number): string {
  let label = `compacted (${trigger})`
  if (postTokens !== undefined) label += ` · ${fmtTokens(preTokens)} → ${fmtTokens(postTokens)}`
  return label
}

function closeOpenFence(buf: string): string {
  const fenceLines = buf.match(/^```/gm)?.length ?? 0
  return fenceLines % 2 === 1 ? buf + '\n```' : buf
}

function AssistantSegments({
  segments,
  currentText,
}: {
  segments: TurnSegment[]
  currentText?: string
}): React.JSX.Element {
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {seg.content}
          </ReactMarkdown>
        ) : (
          <ToolChipEl key={i} chip={seg.chip} />
        )
      )}
      {currentText !== undefined && currentText !== '' && (
        <ReactMarkdown
          key="streaming"
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {closeOpenFence(currentText)}
        </ReactMarkdown>
      )}
    </>
  )
}

// ── Transcript ───────────────────────────────────────────────────────────────

interface ActiveTurnState {
  segments: TurnSegment[]
  currentText: string
}

interface Props {
  turns: Turn[]
  activeTurn: ActiveTurnState | null
  shellLoading: boolean
  authError: AuthError | null
  onDismissAuthError: () => void
  blockingError: BlockingError | null
  onDismissBlockingError: () => void
  onRetry: () => void
  configError: ConfigError | null
  onDismissConfigError: () => void
}

function Transcript({ turns, activeTurn, shellLoading, authError, onDismissAuthError, blockingError, onDismissBlockingError, onRetry, configError, onDismissConfigError }: Props): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, activeTurn, shellLoading])

  const showSpinner =
    activeTurn !== null &&
    activeTurn.segments.length === 0 &&
    activeTurn.currentText === ''

  return (
    <>
      {blockingError && <BlockingErrorBanner error={blockingError} onDismiss={onDismissBlockingError} onRetry={onRetry} />}
      {configError && <ConfigErrorBanner error={configError} onDismiss={onDismissConfigError} />}
      {authError && <AuthBanner error={authError} onDismiss={onDismissAuthError} />}
      {turns.map((turn, i) => (
        <div key={i} className={`turn turn-${turn.role}`}>
          {turn.role === 'user' ? (
            <div className="user-text">
              {turn.images && turn.images.length > 0 && (
                <div className="user-images">
                  {turn.images.map((img, j) => (
                    <img key={j} src={img.dataUrl} alt="Attached image" className="user-image-thumb" />
                  ))}
                </div>
              )}
              {turn.text && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownComponents}
                >
                  {turn.text}
                </ReactMarkdown>
              )}
            </div>
          ) : turn.role === 'compaction' ? (
            <div className="compact-divider">
              <span className="compact-divider-line" />
              <span className="compact-divider-label">
                {compactionLabel(turn.trigger, turn.preTokens, turn.postTokens)}
              </span>
              <span className="compact-divider-line" />
            </div>
          ) : turn.role === 'system' ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {turn.markdown}
            </ReactMarkdown>
          ) : (
            <>
              <AssistantSegments segments={turn.segments} />
              {turn.interrupted && <div className="interrupted">[interrupted]</div>}
            </>
          )}
        </div>
      ))}
      {activeTurn !== null && (
        <div className="turn turn-assistant streaming">
          <AssistantSegments
            segments={activeTurn.segments}
            currentText={activeTurn.currentText}
          />
          {showSpinner && (
            <div className="activity-spinner" aria-label="Working">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          )}
        </div>
      )}
      {shellLoading && !activeTurn && (
        <div className="activity-spinner" aria-label="Working">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      )}
      <div ref={endRef} />
    </>
  )
}

// ── ResponseView ─────────────────────────────────────────────────────────────

export class ResponseView {
  private root: Root
  private turns: Turn[] = []
  private activeTurn: {
    segments: TurnSegment[]
    currentText: string
    chipMap: Map<string, ToolChip>
  } | null = null
  private authError: AuthError | null = null
  private blockingError: BlockingError | null = null
  private configError: ConfigError | null = null
  private shellLoading = false

  constructor(container: HTMLElement) {
    this.root = createRoot(container)
    this.render()
  }

  private render(): void {
    const activeTurnState = this.activeTurn
      ? { segments: this.activeTurn.segments, currentText: this.activeTurn.currentText }
      : null
    this.root.render(
      <Transcript
        turns={this.turns}
        activeTurn={activeTurnState}
        shellLoading={this.shellLoading}
        authError={this.authError}
        onDismissAuthError={() => { this.authError = null; this.render() }}
        blockingError={this.blockingError}
        onDismissBlockingError={() => { this.blockingError = null; this.render() }}
        onRetry={() => { this.blockingError = null; void window.api.session.retry(); this.render() }}
        configError={this.configError}
        onDismissConfigError={() => { this.configError = null; this.render() }}
      />
    )
  }

  showConfigError(error: ConfigError | null): void {
    this.configError = error
    this.render()
  }

  showBlockingError(error: BlockingError | null): void {
    this.blockingError = error
    this.render()
  }

  showAuthError(error: AuthError | null): void {
    this.authError = error
    this.render()
  }

  addCompactionMarker(info: CompactionInfo): void {
    this.turns.push({
      role: 'compaction',
      turnNum: info.turnNum,
      trigger: info.trigger,
      preTokens: info.preTokens,
      postTokens: info.postTokens,
    })
    this.render()
  }

  addUserTurn(text: string, images?: SerializedImage[]): void {
    this.turns.push({ role: 'user', text, images })
    this.render()
  }

  addCompletedAssistantTurn(text: string): void {
    this.turns.push({ role: 'assistant', segments: [{ kind: 'text', content: text }] })
    this.render()
  }

  startAssistantTurn(): void {
    this.activeTurn = { segments: [], currentText: '', chipMap: new Map() }
    this.render()
  }

  appendDelta(delta: string): void {
    if (!this.activeTurn) return
    this.activeTurn.currentText += delta
    this.render()
  }

  addToolChip(toolId: string, label: string): void {
    if (!this.activeTurn) return
    // Freeze any buffered streaming text as a text segment
    if (this.activeTurn.currentText) {
      this.activeTurn.segments.push({ kind: 'text', content: this.activeTurn.currentText })
      this.activeTurn.currentText = ''
    }
    const chip: ToolChip = { toolId, label, status: 'pending' }
    this.activeTurn.chipMap.set(toolId, chip)
    this.activeTurn.segments.push({ kind: 'chip', chip })
    this.render()
  }

  updateToolChip(toolId: string, status: 'ok' | 'error' | 'denied'): void {
    if (!this.activeTurn) return
    const chip = this.activeTurn.chipMap.get(toolId)
    if (chip) {
      chip.status = status
      this.render()
    }
  }

  private freezeActiveTurn(interrupted = false): void {
    if (!this.activeTurn) return
    if (this.activeTurn.currentText) {
      this.activeTurn.segments.push({ kind: 'text', content: this.activeTurn.currentText })
    }
    this.turns.push({ role: 'assistant', segments: this.activeTurn.segments, interrupted })
    this.activeTurn = null
    this.render()
  }

  finishAssistantTurn(): void { this.freezeActiveTurn(false) }
  markInterrupted(): void    { this.freezeActiveTurn(true) }

  setShellLoading(loading: boolean): void {
    this.shellLoading = loading
    this.render()
  }

  addSystemMessage(markdown: string): void {
    this.turns.push({ role: 'system', markdown })
    this.render()
  }

  clear(): void {
    this.turns = []
    this.activeTurn = null
    this.authError = null
    this.blockingError = null
    this.render()
  }
}
