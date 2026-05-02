import type { ConfigBootstrap, EffortLevel, ModelOption, UsageState, AuthInfo, RateLimitStatus, SignInStatus } from '../../shared/ipc'

export interface StatusBarHandle {
  /** Switch to monitoring mode: pickers freeze, usage chips appear. Idempotent. */
  freeze(): void
}

// Config-mode status bar. Renders `cwd | model | effort` with [change]
// affordances. cwd opens the native folder picker; model and effort open
// inline dropdowns.

function shortenCwd(path: string): string {
  // Replace $HOME with ~ for compactness; otherwise show as-is.
  // process is not in the renderer; fall back to a heuristic via the
  // path's first segment.
  const home = path.match(/^(\/Users\/[^/]+)/)?.[1]
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length)
    return rest === '' ? '~/' : '~' + rest
  }
  return path
}

function modelLabel(id: string, models: ModelOption[]): string {
  return models.find((m) => m.id === id)?.label ?? id
}

export async function mountStatusBar(container: HTMLElement): Promise<StatusBarHandle> {
  const config = await window.api.config.get()
  if (!config) return { freeze: () => {} }

  let current: ConfigBootstrap = config
  let frozen = false
  let usage: UsageState = {}
  let auth: AuthInfo | null = null
  let signInStatus: SignInStatus = { inProgress: false }

  container.innerHTML = ''
  container.classList.add('status-bar-config')

  const cwdItem  = document.createElement('button')
  const sep1     = document.createElement('span')
  const modelItem = document.createElement('button')
  const sep2     = document.createElement('span')
  const effortItem = document.createElement('button')
  const sep3SignIn = document.createElement('span')
  const signInItem = document.createElement('button')
  // Usage chip container — appended only after freeze().
  const usageWrap = document.createElement('span')
  usageWrap.className = 'sb-usage'

  for (const sep of [sep1, sep2, sep3SignIn]) {
    sep.className = 'sb-sep'
    sep.textContent = '|'
  }

  cwdItem.className = 'sb-item'
  modelItem.className = 'sb-item'
  effortItem.className = 'sb-item'
  signInItem.className = 'sb-item sb-sign-in'

  function paint(): void {
    const changeAffordance = frozen ? '' : '<span class="sb-change">[change]</span>'
    cwdItem.innerHTML    = `<span class="sb-value">${escapeHtml(shortenCwd(current.cwd))}</span>${changeAffordance}`
    modelItem.innerHTML  = `<span class="sb-value">${escapeHtml(modelLabel(current.model, current.models))}</span>${changeAffordance}`
    effortItem.innerHTML = `<span class="sb-value">${escapeHtml(current.effort)}</span>${changeAffordance}`
    if (!frozen) paintSignIn()
    if (frozen) paintUsage()
  }

  function paintSignIn(): void {
    if (signInStatus.inProgress) {
      signInItem.textContent = 'Signing in…'
      signInItem.disabled = true
    } else if (signInStatus.error) {
      signInItem.textContent = 'Sign in failed'
      signInItem.title = signInStatus.error
      signInItem.disabled = false
    } else {
      signInItem.textContent = 'Sign in with Claude'
      signInItem.title = ''
      signInItem.disabled = false
    }
  }

  function paintUsage(): void {
    const parts: string[] = []
    if (auth) parts.push(authChip(auth.label))
    parts.push(usageChip('Ctx', usage.ctxPct))
    if (auth?.showCost && usage.costUsd !== undefined) parts.push(costChip(usage.costUsd))
    parts.push(rateLimitChip('5h', usage.fiveHourPct, usage.fiveHourStatus))
    parts.push(rateLimitChip('7d', usage.sevenDayPct, usage.sevenDayStatus))
    usageWrap.innerHTML = parts.join('<span class="sb-usage-sep">•</span>')
  }

  paint()
  container.append(cwdItem, sep1, modelItem, sep2, effortItem, sep3SignIn, signInItem)

  cwdItem.addEventListener('click', async () => {
    if (frozen) return
    const chosen = await window.api.config.pickCwd()
    if (chosen) {
      current = { ...current, cwd: chosen }
      paint()
    }
  })

  modelItem.addEventListener('click', () => {
    if (frozen) return
    openDropdown(modelItem, current.models.map((m) => ({ value: m.id, label: m.label })), current.model, async (value) => {
      await window.api.config.setModel(value)
      current = { ...current, model: value }
      paint()
    })
  })

  effortItem.addEventListener('click', () => {
    if (frozen) return
    openDropdown(effortItem, current.effortLevels.map((e) => ({ value: e, label: e })), current.effort, async (value) => {
      const effort = value as EffortLevel
      await window.api.config.setEffort(effort)
      current = { ...current, effort }
      paint()
    })
  })

  signInItem.addEventListener('click', () => {
    if (frozen || signInStatus.inProgress) return
    void window.api.session.signIn()
  })

  window.api.session.onSignInStatus((s) => {
    signInStatus = s
    if (!frozen) paintSignIn()
  })

  window.api.session.onUsage((u) => {
    usage = { ...usage, ...u }
    if (frozen) paintUsage()
  })

  window.api.session.onAuth((a) => {
    auth = a
    if (frozen) paintUsage()
  })

  return {
    freeze(): void {
      if (frozen) return
      frozen = true
      container.classList.remove('status-bar-config')
      container.classList.add('status-bar-monitoring')
      // Remove sign-in affordance; replace with usage chips.
      sep3SignIn.remove()
      signInItem.remove()
      const sepUsage = document.createElement('span')
      sepUsage.className = 'sb-sep'
      sepUsage.textContent = '|'
      container.append(sepUsage, usageWrap)
      paint()
    },
  }
}

function authChip(label: string): string {
  return `<span class="sb-usage-chip sb-auth-chip">${escapeHtml(label)}</span>`
}

function usageChip(label: string, pct: number | undefined): string {
  if (pct === undefined) {
    return `<span class="sb-usage-chip"><span class="sb-usage-label">${label}</span> <span class="sb-usage-pct sb-usage-pending">—</span></span>`
  }
  const color = pct > 85 ? 'red' : pct >= 60 ? 'amber' : 'green'
  return `<span class="sb-usage-chip"><span class="sb-usage-label">${label}</span> <span class="sb-usage-pct sb-usage-${color}">${pct}%</span></span>`
}

function rateLimitChip(label: string, pct: number | undefined, status: RateLimitStatus | undefined): string {
  if (pct !== undefined) {
    const color = pct > 85 ? 'red' : pct >= 60 ? 'amber' : 'green'
    return `<span class="sb-usage-chip"><span class="sb-usage-label">${label}</span> <span class="sb-usage-pct sb-usage-${color}">${pct}%</span></span>`
  }
  if (status !== undefined) {
    const [color, symbol] = status === 'rejected' ? ['red', '✗'] : status === 'allowed_warning' ? ['amber', '!'] : ['green', '✓']
    return `<span class="sb-usage-chip"><span class="sb-usage-label">${label}</span> <span class="sb-usage-pct sb-usage-${color}">${symbol}</span></span>`
  }
  return `<span class="sb-usage-chip"><span class="sb-usage-label">${label}</span> <span class="sb-usage-pct sb-usage-pending">—</span></span>`
}

function costChip(usd: number): string {
  const formatted = usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
  return `<span class="sb-usage-chip"><span class="sb-usage-pct">~${escapeHtml(formatted)}</span></span>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}

interface DropdownOption {
  value: string
  label: string
}

function openDropdown(
  anchor: HTMLElement,
  options: DropdownOption[],
  current: string,
  onPick: (value: string) => void,
): void {
  // Close any existing dropdown first.
  document.querySelectorAll('.sb-dropdown').forEach((el) => el.remove())

  const menu = document.createElement('div')
  menu.className = 'sb-dropdown'

  for (const opt of options) {
    const item = document.createElement('button')
    item.className = 'sb-dropdown-item'
    item.textContent = opt.label
    if (opt.value === current) item.classList.add('selected')
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.remove()
      onPick(opt.value)
    })
    menu.append(item)
  }

  document.body.append(menu)
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 2}px`
  menu.style.left = `${rect.left}px`

  setTimeout(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) {
        menu.remove()
        document.removeEventListener('mousedown', onDocClick)
      }
    }
    document.addEventListener('mousedown', onDocClick)
  }, 0)
}
