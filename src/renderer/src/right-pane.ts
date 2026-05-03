import type { TurnStats, LogEvent, PermissionRequest, PermissionChoice } from '../../shared/ipc'

export interface RightPaneHandle {
  setActive(activity?: string): void
  setIdle(): void
}

export function mountRightPane(
  headerEl: HTMLElement,
  logEl: HTMLElement,
  onInterrupt: () => void,
): RightPaneHandle {
  let lastStats: TurnStats | null = null

  // ── Header ────────────────────────────────────────────────────────────────

  function renderActive(activity = 'Working…'): void {
    headerEl.innerHTML = ''
    headerEl.className = 'right-header right-header-active'

    const activitySpan = document.createElement('span')
    activitySpan.className = 'rh-activity'
    activitySpan.textContent = activity

    const interruptBtn = document.createElement('button')
    interruptBtn.className = 'rh-interrupt'
    interruptBtn.type = 'button'
    interruptBtn.textContent = 'Interrupt'
    interruptBtn.addEventListener('click', onInterrupt)

    headerEl.append(activitySpan, interruptBtn)
  }

  function renderIdle(): void {
    headerEl.innerHTML = ''
    headerEl.className = 'right-header right-header-idle'

    if (!lastStats) {
      const placeholder = document.createElement('span')
      placeholder.className = 'rh-placeholder'
      placeholder.textContent = 'No turn yet'
      headerEl.append(placeholder)
      return
    }

    const { inputTokens, outputTokens, durationMs, model } = lastStats
    const stats = document.createElement('span')
    stats.className = 'rh-stats'
    stats.innerHTML = [
      `<span class="rh-label">in</span> <span class="rh-val">${inputTokens.toLocaleString()}</span>`,
      `<span class="rh-label">out</span> <span class="rh-val">${outputTokens.toLocaleString()}</span>`,
      `<span class="rh-val">${formatMs(durationMs)}</span>`,
      `<span class="rh-model">${escapeHtml(model)}</span>`,
    ].join('<span class="rh-sep">·</span>')

    headerEl.append(stats)
  }

  window.api.session.onTurnStats((stats) => {
    lastStats = stats
  })

  renderIdle()

  // ── View toggle (Structured / Raw JSON) ────────────────────────────────────

  let viewMode: 'structured' | 'raw' = 'structured'
  const rawEvents: LogEvent[] = []

  const toggleBar = document.createElement('div')
  toggleBar.className = 'rl-toggle-bar'

  const structuredBtn = document.createElement('button')
  structuredBtn.className = 'rl-toggle-btn rl-toggle-active'
  structuredBtn.type = 'button'
  structuredBtn.textContent = 'Structured'

  const rawBtn = document.createElement('button')
  rawBtn.className = 'rl-toggle-btn'
  rawBtn.type = 'button'
  rawBtn.textContent = 'Raw JSON'

  toggleBar.append(structuredBtn, rawBtn)
  logEl.insertAdjacentElement('beforebegin', toggleBar)

  const rawEl = document.createElement('div')
  rawEl.className = 'rl-raw-log'
  rawEl.hidden = true
  logEl.insertAdjacentElement('afterend', rawEl)

  function appendRawBlock(ev: LogEvent): void {
    const pre = document.createElement('pre')
    pre.className = 'rl-raw-event'
    pre.textContent = JSON.stringify(ev, null, 2)
    rawEl.append(pre)
    rawEl.scrollTop = rawEl.scrollHeight
  }

  function rebuildRawView(): void {
    rawEl.innerHTML = ''
    for (const ev of rawEvents) appendRawBlock(ev)
  }

  structuredBtn.addEventListener('click', () => {
    if (viewMode === 'structured') return
    viewMode = 'structured'
    structuredBtn.classList.add('rl-toggle-active')
    rawBtn.classList.remove('rl-toggle-active')
    logEl.hidden = false
    rawEl.hidden = true
  })

  rawBtn.addEventListener('click', () => {
    if (viewMode === 'raw') return
    viewMode = 'raw'
    rawBtn.classList.add('rl-toggle-active')
    structuredBtn.classList.remove('rl-toggle-active')
    rebuildRawView()
    logEl.hidden = true
    rawEl.hidden = false
  })

  // ── Event log ──────────────────────────────────────────────────────────────
  // Maps toolId → the card element so we can attach the result.

  const toolCards = new Map<string, HTMLElement>()

  function appendTurnSep(turnNum: number): void {
    const sep = document.createElement('div')
    sep.className = 'rl-turn-sep'
    sep.textContent = `— Turn ${turnNum} —`
    logEl.append(sep)
    logEl.scrollTop = logEl.scrollHeight
  }

  function appendToolCard(ev: LogEvent): void {
    const card = document.createElement('div')
    card.className = 'rl-tool-card'

    const header = document.createElement('div')
    header.className = 'rl-card-header'

    const expandBtn = document.createElement('button')
    expandBtn.className = 'rl-expand-btn'
    expandBtn.type = 'button'
    expandBtn.setAttribute('aria-expanded', 'false')
    expandBtn.textContent = '▶'

    const icon = document.createElement('span')
    icon.className = 'rl-tool-icon'
    icon.textContent = '⚙'

    const name = document.createElement('span')
    name.className = 'rl-tool-name'
    name.textContent = ev.toolName ?? '(tool)'

    const status = document.createElement('span')
    status.className = 'rl-tool-status'
    status.textContent = '…'

    header.append(expandBtn, icon, name, status)

    const body = document.createElement('div')
    body.className = 'rl-card-body'
    body.hidden = true

    if (ev.inputJson) {
      const inputSection = document.createElement('div')
      inputSection.className = 'rl-section'
      const inputLabel = document.createElement('div')
      inputLabel.className = 'rl-section-label'
      inputLabel.textContent = 'Input'
      const inputPre = document.createElement('pre')
      inputPre.className = 'rl-json'
      inputPre.textContent = ev.inputJson
      inputSection.append(inputLabel, inputPre)
      body.append(inputSection)
    }

    // Output section placeholder — filled when tool_result arrives
    const outputSection = document.createElement('div')
    outputSection.className = 'rl-section rl-output-section'
    outputSection.hidden = true
    body.append(outputSection)

    card.append(header, body)

    expandBtn.addEventListener('click', () => {
      const expanded = body.hidden
      body.hidden = !expanded
      expandBtn.setAttribute('aria-expanded', String(expanded))
      expandBtn.textContent = expanded ? '▼' : '▶'
    })

    if (ev.toolId) {
      card.dataset.toolId = ev.toolId
      toolCards.set(ev.toolId, card)
    }

    logEl.append(card)
    logEl.scrollTop = logEl.scrollHeight
  }

  function applyToolResult(ev: LogEvent): void {
    const card = ev.toolId ? toolCards.get(ev.toolId) : undefined
    if (!card) return

    const status = card.querySelector<HTMLElement>('.rl-tool-status')
    if (status) {
      status.textContent = ev.isError ? '✗' : '✓'
      status.className = `rl-tool-status ${ev.isError ? 'rl-status-error' : 'rl-status-ok'}`
    }

    if (ev.outputText !== undefined && ev.outputText !== '') {
      const outputSection = card.querySelector<HTMLElement>('.rl-output-section')
      if (outputSection) {
        outputSection.hidden = false
        const label = document.createElement('div')
        label.className = 'rl-section-label'
        label.textContent = ev.isError ? 'Error' : 'Output'
        const pre = document.createElement('pre')
        pre.className = `rl-output-pre${ev.isError ? ' rl-error-pre' : ''}`
        pre.textContent = ev.outputText
        outputSection.append(label, pre)
      }
    }

    if (ev.isError) card.classList.add('rl-tool-card-error')
    logEl.scrollTop = logEl.scrollHeight
  }

  function appendTextChip(ev: LogEvent): void {
    const chip = document.createElement('div')
    chip.className = 'rl-text-chip'
    const len = ev.textLength ?? 0
    chip.textContent = `✦ ${len.toLocaleString()} chars`
    logEl.append(chip)
    logEl.scrollTop = logEl.scrollHeight
  }

  window.api.session.onLogEvent((ev) => {
    rawEvents.push(ev)
    if (viewMode === 'raw') {
      appendRawBlock(ev)
    }

    if (ev.kind === 'turn_start') {
      appendTurnSep(ev.turnNum ?? 0)
    } else if (ev.kind === 'tool_call') {
      appendToolCard(ev)
      renderActive(`Using ${ev.toolName ?? 'tool'}…`)
    } else if (ev.kind === 'tool_result') {
      applyToolResult(ev)
      renderActive()
    } else if (ev.kind === 'assistant_text') {
      appendTextChip(ev)
    }
  })

  // ── Permission modal ────────────────────────────────────────────────────────

  let pendingPermissionToolId: string | null = null
  let pendingHasSuggestions = false

  const CHOICE_LABELS: Record<PermissionChoice, string> = {
    allow_once:    '✓ Allowed once',
    allow_session: '✓ Allowed for session',
    deny:          '✗ Denied',
  }

  function resolvePermission(toolId: string, choice: PermissionChoice): void {
    if (toolId !== pendingPermissionToolId) return
    pendingPermissionToolId = null
    pendingHasSuggestions = false

    const card = logEl.querySelector<HTMLElement>(`.rl-permission-card[data-tool-id="${CSS.escape(toolId)}"]`)
    if (card) {
      const actions = card.querySelector<HTMLElement>('.rl-perm-actions')
      if (actions) {
        actions.innerHTML = ''
        const decision = document.createElement('span')
        decision.className = `rl-perm-decision ${choice === 'deny' ? 'rl-perm-denied' : 'rl-perm-allowed'}`
        decision.textContent = CHOICE_LABELS[choice]
        actions.append(decision)
      }
      card.classList.add(choice === 'deny' ? 'rl-permission-denied' : 'rl-permission-allowed')
    }

    renderActive()
    void window.api.session.permissionResponse(toolId, choice)
  }

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!pendingPermissionToolId) return
    const id = pendingPermissionToolId
    if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault()
      resolvePermission(id, 'allow_once')
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault()
      resolvePermission(id, 'deny')
    } else if (e.key === '1') {
      e.preventDefault()
      resolvePermission(id, 'allow_once')
    } else if (e.key === '2' && pendingHasSuggestions) {
      e.preventDefault()
      resolvePermission(id, 'allow_session')
    } else if (e.key === '3') {
      e.preventDefault()
      resolvePermission(id, 'deny')
    }
  })

  window.api.session.onPermissionRequest((req: PermissionRequest) => {
    pendingPermissionToolId = req.toolId
    pendingHasSuggestions = req.hasSuggestions
    renderActive(`Awaiting permission for ${req.toolName}…`)

    const card = document.createElement('div')
    card.className = 'rl-permission-card'
    card.dataset.toolId = req.toolId

    const header = document.createElement('div')
    header.className = 'rl-perm-header'

    const icon = document.createElement('span')
    icon.className = 'rl-perm-icon'
    icon.textContent = '🔐'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'rl-perm-name'
    nameSpan.textContent = req.toolName

    const badge = document.createElement('span')
    badge.className = 'rl-perm-badge'
    badge.textContent = 'permission required'

    header.append(icon, nameSpan, badge)

    const body = document.createElement('div')
    body.className = 'rl-perm-body'

    if (req.title) {
      const titleEl = document.createElement('div')
      titleEl.className = 'rl-perm-title'
      titleEl.textContent = req.title
      body.append(titleEl)
    }

    if (req.description) {
      const descEl = document.createElement('div')
      descEl.className = 'rl-perm-desc'
      descEl.textContent = req.description
      body.append(descEl)
    }

    const actions = document.createElement('div')
    actions.className = 'rl-perm-actions'

    if (req.hasSuggestions) {
      // 3-option flow: allow once / allow session / deny
      const onceBtn = document.createElement('button')
      onceBtn.className = 'rl-perm-btn rl-perm-allow-btn'
      onceBtn.type = 'button'
      onceBtn.textContent = '1 · Allow once'
      onceBtn.addEventListener('click', () => resolvePermission(req.toolId, 'allow_once'))

      const sessionBtn = document.createElement('button')
      sessionBtn.className = 'rl-perm-btn rl-perm-allow-btn'
      sessionBtn.type = 'button'
      sessionBtn.textContent = '2 · Allow session'
      sessionBtn.addEventListener('click', () => resolvePermission(req.toolId, 'allow_session'))

      const denyBtn = document.createElement('button')
      denyBtn.className = 'rl-perm-btn rl-perm-deny-btn'
      denyBtn.type = 'button'
      denyBtn.textContent = '3 · Deny'
      denyBtn.addEventListener('click', () => resolvePermission(req.toolId, 'deny'))

      actions.append(onceBtn, sessionBtn, denyBtn)
      body.append(actions)
      card.append(header, body)
      logEl.append(card)
      logEl.scrollTop = logEl.scrollHeight
      onceBtn.focus()
    } else {
      // 2-option flow: allow / deny
      const allowBtn = document.createElement('button')
      allowBtn.className = 'rl-perm-btn rl-perm-allow-btn'
      allowBtn.type = 'button'
      allowBtn.textContent = 'Allow  (y)'
      allowBtn.addEventListener('click', () => resolvePermission(req.toolId, 'allow_once'))

      const denyBtn = document.createElement('button')
      denyBtn.className = 'rl-perm-btn rl-perm-deny-btn'
      denyBtn.type = 'button'
      denyBtn.textContent = 'Deny  (n)'
      denyBtn.addEventListener('click', () => resolvePermission(req.toolId, 'deny'))

      actions.append(allowBtn, denyBtn)
      body.append(actions)
      card.append(header, body)
      logEl.append(card)
      logEl.scrollTop = logEl.scrollHeight
      allowBtn.focus()
    }
  })

  return {
    setActive(activity?: string): void { renderActive(activity) },
    setIdle(): void { renderIdle() },
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}
