const leftCol = document.getElementById('left-col') as HTMLElement
const responsePane = document.getElementById('response-pane') as HTMLElement
const promptPane = document.getElementById('prompt-pane') as HTMLElement
const colDivider = document.getElementById('col-divider') as HTMLElement
const rowDivider = document.getElementById('row-divider') as HTMLElement

// ── Layout persistence ──────────────────────────────────────────────────────

async function loadLayout(): Promise<void> {
  const state = await window.api.layout.load()
  if (state !== null) {
    leftCol.style.flex = 'none'
    leftCol.style.width = `${state.leftWidth}px`
    promptPane.style.flex = 'none'
    promptPane.style.height = `${state.promptHeight}px`
    responsePane.style.flex = '1'
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const leftWidth = leftCol.getBoundingClientRect().width
    const promptHeight = promptPane.getBoundingClientRect().height
    void window.api.layout.save({ leftWidth, promptHeight })
    saveTimer = null
  }, 500)
}

void loadLayout()

// ── Drag handling ───────────────────────────────────────────────────────────

type DragTarget = 'col' | 'row'
let active: DragTarget | null = null
let dragStart = 0
let sizeAtStart = 0

colDivider.addEventListener('mousedown', (e: MouseEvent) => {
  active = 'col'
  dragStart = e.clientX
  sizeAtStart = leftCol.getBoundingClientRect().width
  leftCol.style.flex = 'none'
  leftCol.style.width = `${sizeAtStart}px`
  e.preventDefault()
})

rowDivider.addEventListener('mousedown', (e: MouseEvent) => {
  active = 'row'
  dragStart = e.clientY
  sizeAtStart = promptPane.getBoundingClientRect().height
  promptPane.style.flex = 'none'
  promptPane.style.height = `${sizeAtStart}px`
  responsePane.style.flex = '1'
  e.preventDefault()
})

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (active === 'col') {
    const newWidth = Math.max(200, Math.min(window.innerWidth - 154, sizeAtStart + (e.clientX - dragStart)))
    leftCol.style.width = `${newWidth}px`
  } else if (active === 'row') {
    const newHeight = Math.max(80, sizeAtStart - (e.clientY - dragStart))
    promptPane.style.height = `${newHeight}px`
  }
})

document.addEventListener('mouseup', () => {
  if (active !== null) scheduleSave()
  active = null
})
