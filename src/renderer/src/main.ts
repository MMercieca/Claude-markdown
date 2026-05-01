const leftCol = document.getElementById('left-col') as HTMLElement
const responsePane = document.getElementById('response-pane') as HTMLElement
const promptPane = document.getElementById('prompt-pane') as HTMLElement
const colDivider = document.getElementById('col-divider') as HTMLElement
const rowDivider = document.getElementById('row-divider') as HTMLElement

type DragTarget = 'col' | 'row'
let active: DragTarget | null = null
let dragStart = 0
let sizeAtStart = 0

colDivider.addEventListener('mousedown', (e: MouseEvent) => {
  active = 'col'
  dragStart = e.clientX
  sizeAtStart = leftCol.getBoundingClientRect().width
  // Switch from flex ratio to explicit width so delta math is stable
  leftCol.style.flex = 'none'
  leftCol.style.width = `${sizeAtStart}px`
  e.preventDefault()
})

rowDivider.addEventListener('mousedown', (e: MouseEvent) => {
  active = 'row'
  dragStart = e.clientY
  sizeAtStart = promptPane.getBoundingClientRect().height
  // Switch prompt to explicit height; response takes the rest via flex: 1
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
    // Drag divider down → response grows, prompt shrinks (prompt height decreases)
    const newHeight = Math.max(80, sizeAtStart - (e.clientY - dragStart))
    promptPane.style.height = `${newHeight}px`
  }
})

document.addEventListener('mouseup', () => { active = null })
