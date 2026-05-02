import type { ConfigBootstrap, EffortLevel, ModelOption } from '../../shared/ipc'

// Config-mode status bar. Renders `cwd | model | effort` with [change]
// affordances. cwd opens the native folder picker; model and effort open
// inline dropdowns.

function shortenCwd(path: string): string {
  // Replace $HOME with ~ for compactness; otherwise show as-is.
  // process is not in the renderer; fall back to a heuristic via the
  // path's first segment.
  const home = path.match(/^(\/Users\/[^/]+)/)?.[1]
  if (home && path.startsWith(home)) return '~' + path.slice(home.length)
  return path
}

function modelLabel(id: string, models: ModelOption[]): string {
  return models.find((m) => m.id === id)?.label ?? id
}

export async function mountStatusBar(container: HTMLElement): Promise<void> {
  const config = await window.api.config.get()
  if (!config) return

  let current: ConfigBootstrap = config

  container.innerHTML = ''
  container.classList.add('status-bar-config')

  const cwdItem  = document.createElement('button')
  const sep1     = document.createElement('span')
  const modelItem = document.createElement('button')
  const sep2     = document.createElement('span')
  const effortItem = document.createElement('button')

  for (const sep of [sep1, sep2]) {
    sep.className = 'sb-sep'
    sep.textContent = '|'
  }

  cwdItem.className = 'sb-item'
  modelItem.className = 'sb-item'
  effortItem.className = 'sb-item'

  function paint(): void {
    cwdItem.innerHTML = `<span class="sb-value">${escapeHtml(shortenCwd(current.cwd))}</span><span class="sb-change">[change]</span>`
    modelItem.innerHTML = `<span class="sb-value">${escapeHtml(modelLabel(current.model, current.models))}</span><span class="sb-change">[change]</span>`
    effortItem.innerHTML = `<span class="sb-value">${escapeHtml(current.effort)}</span><span class="sb-change">[change]</span>`
  }

  paint()

  container.append(cwdItem, sep1, modelItem, sep2, effortItem)

  cwdItem.addEventListener('click', async () => {
    const chosen = await window.api.config.pickCwd()
    if (chosen) {
      current = { ...current, cwd: chosen }
      paint()
    }
  })

  modelItem.addEventListener('click', () => {
    openDropdown(modelItem, current.models.map((m) => ({ value: m.id, label: m.label })), current.model, async (value) => {
      await window.api.config.setModel(value)
      current = { ...current, model: value }
      paint()
    })
  })

  effortItem.addEventListener('click', () => {
    openDropdown(effortItem, current.effortLevels.map((e) => ({ value: e, label: e })), current.effort, async (value) => {
      const effort = value as EffortLevel
      await window.api.config.setEffort(effort)
      current = { ...current, effort }
      paint()
    })
  })
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
