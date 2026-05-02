import type { TurnStats } from '../../shared/ipc'

export interface RightPaneHandle {
  setActive(): void
  setIdle(): void
}

export function mountRightPane(
  headerEl: HTMLElement,
  onInterrupt: () => void,
): RightPaneHandle {
  let lastStats: TurnStats | null = null

  window.api.session.onTurnStats((stats) => {
    lastStats = stats
  })

  function renderActive(): void {
    headerEl.innerHTML = ''
    headerEl.className = 'right-header right-header-active'

    const activity = document.createElement('span')
    activity.className = 'rh-activity'
    activity.textContent = 'Working…'

    const interruptBtn = document.createElement('button')
    interruptBtn.className = 'rh-interrupt'
    interruptBtn.type = 'button'
    interruptBtn.textContent = 'Interrupt'
    interruptBtn.addEventListener('click', onInterrupt)

    headerEl.append(activity, interruptBtn)
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

  // Start in idle state
  renderIdle()

  return {
    setActive(): void { renderActive() },
    setIdle(): void   { renderIdle() },
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}
