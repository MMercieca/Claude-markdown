import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import 'highlight.js/styles/github.css'
import { ResponseView } from './response'
import { mountStatusBar } from './status-bar'
import { mountRightPane } from './right-pane'
import type { SerializedImage, ImageMediaType } from '../../shared/ipc'

const leftCol = document.getElementById('left-col') as HTMLElement
const responsePane = document.getElementById('response-pane') as HTMLElement
const responseContent = document.getElementById('response-content') as HTMLElement
const statusBar = document.getElementById('status-bar') as HTMLElement
const rightHeader = document.getElementById('right-header') as HTMLElement
const rightLog = document.getElementById('right-log') as HTMLElement
const responseView = new ResponseView(responseContent)
const statusBarReady = mountStatusBar(statusBar)
const promptPane = document.getElementById('prompt-pane') as HTMLElement
const promptEditorEl = document.getElementById('prompt-editor') as HTMLElement
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement
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

// ── CodeMirror editor ───────────────────────────────────────────────────────

// Markdown source-with-decorations: content styled, delimiters dimmed.
// Tags come from @lezer/markdown's style assignments; see its dist/index.js.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1,              fontSize: '1.4em', fontWeight: 'bold' },
  { tag: tags.heading2,              fontSize: '1.2em', fontWeight: 'bold' },
  { tag: tags.heading3,              fontSize: '1.1em', fontWeight: 'bold' },
  { tag: tags.strong,                fontWeight: 'bold' },
  { tag: tags.emphasis,              fontStyle: 'italic' },
  { tag: tags.monospace,             fontFamily: 'monospace', fontSize: '0.9em' },
  // HeaderMark, EmphasisMark, CodeMark, etc. all get processingInstruction
  { tag: tags.processingInstruction, opacity: '0.4' },
])

// Color layer matched to the github (light) highlight.js theme used in the
// response pane, so code/headings/links read the same on both sides.
const markdownColors = HighlightStyle.define([
  { tag: tags.heading,   color: '#8250df' },
  { tag: tags.monospace, color: '#0a3069' },
  { tag: tags.link,      color: '#0969da' },
  { tag: tags.url,       color: '#0969da' },
])

// ── Pasted image store ──────────────────────────────────────────────────────

interface PastedImage extends SerializedImage {
  id: string
}

const pastedImages = new Map<string, PastedImage>()
let imageCounter = 0

const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024   // 5 MB per file/image
const MAX_IMAGE_COUNT = 100                      // per prompt

const IMAGE_RE = /\[image-(\d+): \d+×\d+\]/g

function extractImages(text: string): { sendText: string; sendImages: SerializedImage[] } {
  const sendImages: SerializedImage[] = []
  const sendText = text.replace(IMAGE_RE, (_, num: string) => {
    const id = `image-${num}`
    const img = pastedImages.get(id)
    if (img) {
      sendImages.push({
        mimeType: img.mimeType,
        base64Data: img.base64Data,
        width: img.width,
        height: img.height,
        dataUrl: img.dataUrl,
      })
    }
    return ''
  })
  return { sendText, sendImages }
}

const editableCompartment = new Compartment()

// Tracks whether the agent is currently generating.
let agentActive = false
let insightsTurnCount = 0
let sessionSlashCommands: string[] = []

const rightPane = mountRightPane(rightHeader, rightLog, () => {
  responseView.markInterrupted()
  agentActive = false
  void window.api.session.interrupt()
})

let editor: EditorView

function setEditorEditable(editable: boolean): void {
  editor.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) })
  sendBtn.disabled = !editable
}

function submitPrompt(): boolean {
  const rawText = editor.state.doc.toString().trim()
  if (!rawText) return false
  if (handleSlashCommand(rawText, editor)) return true

  const { sendText, sendImages } = extractImages(rawText)

  if (sendImages.length > MAX_IMAGE_COUNT) {
    responseView.addSystemMessage(
      `**Too many images:** this prompt contains ${sendImages.length} images (limit is ${MAX_IMAGE_COUNT}). Remove some before sending.`
    )
    return true
  }

  const textToSend = sendText.trim()

  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } })
  editor.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) })
  agentActive = true
  insightsTurnCount++
  rightPane.setActive()
  responseView.addUserTurn(textToSend, sendImages.length > 0 ? sendImages : undefined)
  responseView.startAssistantTurn()
  void statusBarReady.then((sb) => sb.freeze())

  if (sendImages.length > 0) {
    void window.api.session.sendContent(textToSend, sendImages)
  } else {
    void window.api.session.send(textToSend)
  }
  return true
}

editor = new EditorView({
  state: EditorState.create({
    extensions: [
      Prec.highest(keymap.of([{
        key: 'Mod-Enter',
        run: (): boolean => submitPrompt(),
      }])),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(markdownHighlight),
      syntaxHighlighting(markdownColors),
      EditorView.lineWrapping,
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.theme({
        '&': { background: 'transparent', color: 'inherit', height: '100%' },
        '.cm-content': { caretColor: 'currentColor' },
        '.cm-cursor': { borderLeftColor: 'currentColor' },
        '.cm-selectionBackground': { background: 'Highlight' },
        '&.cm-focused .cm-selectionBackground': { background: 'Highlight' },
      }),
    ],
  }),
  parent: promptEditorEl,
})

sendBtn.addEventListener('click', () => { submitPrompt(); editor.focus() })

// ── File drag-and-drop ──────────────────────────────────────────────────────

editor.dom.addEventListener('dragover', (e: DragEvent) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
})

editor.dom.addEventListener('drop', (e: DragEvent) => {
  const files = e.dataTransfer?.files
  if (!files?.length) return
  e.preventDefault()
  e.stopPropagation()

  const links: string[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
      responseView.addSystemMessage(
        `**File too large:** ${file.name} is ${sizeMB} MB (limit is 5 MB). Not added.`
      )
      continue
    }
    const absPath = window.api.getFilePath(file)
    if (!absPath) continue
    links.push(`[${file.name}](${absPath})`)
  }

  if (links.length === 0) return

  const insert = links.join(' ')
  const { from } = editor.state.selection.main
  editor.dispatch({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
  })
  editor.focus()
})

// ── Image paste ─────────────────────────────────────────────────────────────

promptEditorEl.addEventListener('paste', (e: ClipboardEvent) => {
  if (!e.clipboardData) return
  const imageItems = Array.from(e.clipboardData.items).filter((item) =>
    item.type.startsWith('image/')
  )
  if (imageItems.length === 0) return

  e.preventDefault()

  for (const item of imageItems) {
    const file = item.getAsFile()
    if (!file) continue

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
      responseView.addSystemMessage(
        `**Image too large:** ${sizeMB} MB exceeds the 5 MB limit. Attachment not added.`
      )
      continue
    }

    const id = `image-${++imageCounter}`
    const mimeType = file.type as ImageMediaType

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64Data = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const img = new Image()
      img.onload = () => {
        pastedImages.set(id, { id, dataUrl, mimeType, base64Data, width: img.naturalWidth, height: img.naturalHeight })
        const placeholder = `[${id}: ${img.naturalWidth}×${img.naturalHeight}]`
        const { from } = editor.state.selection.main
        editor.dispatch({
          changes: { from, insert: placeholder },
          selection: { anchor: from + placeholder.length },
        })
        editor.focus()
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }
}, { capture: true })

// ── Session streaming ───────────────────────────────────────────────────────

window.api.session.onDelta((delta) => {
  responseView.appendDelta(delta)
  responsePane.scrollTop = responsePane.scrollHeight
})

window.api.session.onDone(() => {
  responseView.finishAssistantTurn()
  rightPane.setIdle()
  agentActive = false
  setEditorEditable(true)
  editor.focus()
})

window.api.session.onLogEvent((ev) => {
  if (ev.kind === 'tool_call' && ev.toolId) {
    const label = formatChipLabel(ev.toolName ?? '', ev.inputJson ?? '')
    responseView.addToolChip(ev.toolId, label)
  } else if (ev.kind === 'tool_result' && ev.toolId) {
    const chipStatus = ev.isDenied ? 'denied' : ev.isError ? 'error' : 'ok'
    responseView.updateToolChip(ev.toolId, chipStatus)
  }
})

window.api.session.onAuthError((error) => {
  responseView.showAuthError(error)
})

window.api.session.onSignInStatus((status) => {
  if (!status.inProgress && !status.error) {
    responseView.showAuthError(null)
  }
})

window.api.session.onCompaction((info) => {
  responseView.addCompactionMarker(info)
  rightPane.addCompactionMarker(info)
})
window.api.session.onBlockingError((error) => { responseView.showBlockingError(error) })
window.api.session.onConfigError((error) => { responseView.showConfigError(error) })

window.api.session.onCleared(() => {
  responseView.clear()
  rightPane.clear()
  void statusBarReady.then((sb) => sb.unfreeze())
  insightsTurnCount = 0
  sessionSlashCommands = []
  agentActive = false
  pastedImages.clear()
  imageCounter = 0
  setEditorEditable(true)
  editor.focus()
})

window.api.session.onSlashCommands((cmds) => { sessionSlashCommands = cmds })

// Escape is handled at the document level because the editor is non-editable
// while the agent is active and won't dispatch keymaps in that state.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && agentActive && !document.getElementById('help-overlay')) {
    e.preventDefault()
    responseView.markInterrupted()
    rightPane.setIdle()
    agentActive = false
    void window.api.session.interrupt()
  }
})

// ── Slash command interceptor ───────────────────────────────────────────────
// Commands that spawn the claude CLI as a one-shot subprocess (Option C).
// Grows as the user finds gaps; initial entry is /insights.
const CLI_SLASH_ALLOWLIST = new Set(['insights'])

function handleSlashCommand(text: string, view: EditorView): boolean {
  const cmd = text.split(/\s+/)[0]!.toLowerCase()

  if (cmd === '/clear') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    void window.api.session.clear().then(() => {
      responseView.addSystemMessage(
        'Session cleared. Previous session still on disk — open it via **Cmd+O**.'
      )
    })
    return true
  }

  if (cmd === '/help') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    showHelpOverlay()
    return true
  }

  if (cmd === '/effort') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    handleEffortCommand(text)
    return true
  }

  const cmdName = cmd.startsWith('/') ? cmd.slice(1) : cmd
  if (CLI_SLASH_ALLOWLIST.has(cmdName)) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    void runCliSlash(text)
    return true
  }

  return false
}

async function runCliSlash(cmd: string): Promise<void> {
  setEditorEditable(false)
  rightPane.setActive(`${cmd}…`)
  responseView.setShellLoading(true)
  responseView.addSystemMessage(`_Running \`${cmd}\`…_`)
  try {
    const result = await window.api.session.shellSlash(cmd)
    if (result.error) {
      responseView.addSystemMessage(`**Error:** ${result.error}`)
    } else if (result.output) {
      responseView.addSystemMessage(result.output)
    } else {
      responseView.addSystemMessage('_(no output)_')
    }
  } finally {
    responseView.setShellLoading(false)
    setEditorEditable(true)
    rightPane.setIdle()
  }
}

function handleEffortCommand(text: string): void {
  const parts = text.trim().split(/\s+/)

  if (parts.length === 1) {
    // Bare /effort — show available levels
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    responseView.addSystemMessage(
      `**Available effort levels:** ${levels.map((l) => `\`${l}\``).join(', ')}`
    )
    return
  }

  // /effort <level> is only valid before the first prompt
  if (insightsTurnCount > 0) {
    responseView.addSystemMessage(
      '**/effort** is only valid before the first prompt.\n\nUse **/clear** to start a new session, then **/effort <level>**.'
    )
    return
  }

  const level = parts[1]!.toLowerCase()
  const valid = ['low', 'medium', 'high', 'xhigh', 'max']
  if (!valid.includes(level)) {
    responseView.addSystemMessage(
      `**Unknown effort level:** \`${level}\`\n\nAvailable: ${valid.map((l) => `\`${l}\``).join(', ')}`
    )
    return
  }

  void (async () => {
    await window.api.config.setEffort(level as Parameters<typeof window.api.config.setEffort>[0])
    void statusBarReady.then((sb) => sb.setEffort(level as Parameters<typeof window.api.config.setEffort>[0]))
    responseView.addSystemMessage(`Effort set to **${level}**`)
  })()
}

function showHelpOverlay(): void {
  const existing = document.getElementById('help-overlay')
  if (existing) { existing.remove(); return }

  const overlay = document.createElement('div')
  overlay.id = 'help-overlay'
  overlay.className = 'help-overlay'

  const modal = document.createElement('div')
  modal.className = 'help-modal'

  const title = document.createElement('div')
  title.className = 'help-title'
  title.textContent = 'Claude Markdown'

  const kbSection = document.createElement('div')
  kbSection.className = 'help-section'
  kbSection.innerHTML = `
    <div class="help-section-title">Keybindings</div>
    <table class="help-table">
      <tr><td><kbd>Cmd+Enter</kbd></td><td>Send prompt</td></tr>
      <tr><td><kbd>Enter</kbd></td><td>Newline in prompt</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Interrupt agent</td></tr>
      <tr><td><kbd>y</kbd> / <kbd>n</kbd></td><td>Allow / deny permission</td></tr>
      <tr><td><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd></td><td>Multi-option permission</td></tr>
      <tr><td><kbd>Cmd+N</kbd></td><td>New window</td></tr>
      <tr><td><kbd>Cmd+W</kbd></td><td>Close window</td></tr>
    </table>
  `

  const cmdSection = document.createElement('div')
  cmdSection.className = 'help-section'
  cmdSection.innerHTML = `
    <div class="help-section-title">App slash commands</div>
    <table class="help-table">
      <tr><td><code>/clear</code></td><td>New session — prior session stays on disk (Cmd+O)</td></tr>
      <tr><td><code>/help</code></td><td>Show this overlay</td></tr>
      <tr><td><code>/effort [level]</code></td><td>Set effort (before first prompt)</td></tr>
    </table>
  `

  const backendSection = document.createElement('div')
  backendSection.className = 'help-section'
  if (sessionSlashCommands.length > 0) {
    const sorted = [...sessionSlashCommands].sort()
    backendSection.innerHTML = `
      <div class="help-section-title">Session slash commands</div>
      <div class="help-slash-list">${sorted.map((c) => `<code>/${c}</code>`).join('')}</div>
    `
  } else {
    backendSection.innerHTML = `
      <div class="help-section-title">Session slash commands</div>
      <p class="help-note" style="margin:0">Available after the first prompt is sent.</p>
    `
  }

  const closeBtn = document.createElement('button')
  closeBtn.className = 'help-close-btn'
  closeBtn.type = 'button'
  closeBtn.textContent = 'Close  (Esc)'
  closeBtn.addEventListener('click', () => overlay.remove())

  modal.append(title, kbSection, cmdSection, backendSection, closeBtn)
  overlay.append(modal)
  document.body.append(overlay)

  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) overlay.remove()
  })

  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      overlay.remove()
      document.removeEventListener('keydown', escHandler)
    }
  }
  document.addEventListener('keydown', escHandler)

  closeBtn.focus()
}

// ── Chip label formatting ───────────────────────────────────────────────────

function formatChipLabel(toolName: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>
    const path = input['path'] ?? input['file_path'] ?? input['filename'] ?? input['filepath']
    if (typeof path === 'string') {
      const base = path.split('/').pop() ?? path
      return `${toolName} ${base}`
    }
    const cmd = input['command']
    if (typeof cmd === 'string') {
      const snippet = cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd
      return `${toolName}: ${snippet}`
    }
    const pattern = input['pattern'] ?? input['glob']
    if (typeof pattern === 'string') {
      return `${toolName} ${pattern}`
    }
  } catch { /* fall through */ }
  return toolName
}

// ── Session picker (Cmd+O) ──────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

async function activateSessionPick(sessionId: string, overlay: HTMLElement): Promise<void> {
  overlay.remove()

  if (agentActive) {
    const ok = window.confirm('Interrupt current session and resume the selected one?')
    if (!ok) return
    responseView.markInterrupted()
    rightPane.setIdle()
    agentActive = false
  }

  await window.api.session.resumeSession(sessionId)
  // session:cleared fires before this promise resolves, wiping the panes

  const history = await window.api.session.getHistory()
  for (const turn of history) {
    if (turn.role === 'user') responseView.addUserTurn(turn.text)
    else responseView.addCompletedAssistantTurn(turn.text)
  }
}

async function showSessionPickerOverlay(): Promise<void> {
  if (document.getElementById('session-picker-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'session-picker-overlay'
  overlay.className = 'session-picker-overlay'

  const modal = document.createElement('div')
  modal.className = 'session-picker-modal'

  const title = document.createElement('div')
  title.className = 'session-picker-title'
  title.textContent = 'Open Session'

  const list = document.createElement('div')
  list.className = 'session-picker-list'
  list.textContent = 'Loading…'

  const footer = document.createElement('div')
  footer.className = 'session-picker-footer'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'session-picker-close-btn'
  closeBtn.textContent = 'Close  (Esc)'
  closeBtn.addEventListener('click', () => overlay.remove())

  footer.append(closeBtn)
  modal.append(title, list, footer)
  overlay.append(modal)
  document.body.append(overlay)

  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) overlay.remove()
  })

  const sessionList = await window.api.session.listSessions()
  list.textContent = ''

  if (sessionList.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'session-picker-empty'
    empty.textContent = 'No sessions found for the current directory.'
    list.append(empty)
    closeBtn.focus()
    return
  }

  let selectedIndex = 0
  const rows: HTMLButtonElement[] = []

  const updateSelection = (): void => {
    rows.forEach((row, i) => row.classList.toggle('selected', i === selectedIndex))
    rows[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }

  sessionList.forEach((sess, i) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'session-picker-row'
    if (sess.isCurrentSession) row.classList.add('current-session')

    const idEl = document.createElement('span')
    idEl.className = 'session-picker-id'
    idEl.textContent = sess.sessionId.slice(0, 8)

    const summaryEl = document.createElement('span')
    summaryEl.className = 'session-picker-summary'
    const raw = sess.firstPrompt ?? sess.summary
    summaryEl.textContent = raw.length > 80 ? raw.slice(0, 80) + '…' : raw
    summaryEl.title = raw

    const timeEl = document.createElement('span')
    timeEl.className = 'session-picker-time'
    timeEl.textContent = relativeTime(sess.lastModified)

    row.append(idEl, summaryEl, timeEl)

    const { sessionId, isCurrentSession } = sess
    row.addEventListener('click', () => {
      if (!isCurrentSession) void activateSessionPick(sessionId, overlay)
    })
    row.addEventListener('mouseenter', () => {
      selectedIndex = i
      updateSelection()
    })

    rows.push(row)
    list.append(row)
  })

  updateSelection()

  const keyHandler = (e: KeyboardEvent): void => {
    if (!document.contains(overlay)) {
      document.removeEventListener('keydown', keyHandler)
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      overlay.remove()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex = Math.min(selectedIndex + 1, sessionList.length - 1)
      updateSelection()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex = Math.max(selectedIndex - 1, 0)
      updateSelection()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const sel = sessionList[selectedIndex]
      if (sel && !sel.isCurrentSession) {
        document.removeEventListener('keydown', keyHandler)
        void activateSessionPick(sel.sessionId, overlay)
      }
    }
  }
  document.addEventListener('keydown', keyHandler)

  closeBtn.focus()
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
    e.preventDefault()
    void showSessionPickerOverlay()
  }
})

// ── Session history hydration ───────────────────────────────────────────────
// If this window was restored from a prior session, populate the response pane
// with the prior turns before the user sends anything.

void (async () => {
  const config = await window.api.config.get()
  if (!config?.resumedSessionId) return
  const history = await window.api.session.getHistory()
  for (const turn of history) {
    if (turn.role === 'user') {
      responseView.addUserTurn(turn.text)
    } else {
      responseView.addCompletedAssistantTurn(turn.text)
    }
  }
})()
