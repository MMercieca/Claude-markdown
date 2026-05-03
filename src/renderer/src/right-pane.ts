import type { TurnStats, LogEvent } from '../../shared/ipc'

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
