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
import type { UsageState, AuthInfo, SerializedImage, ImageMediaType } from '../../shared/ipc'

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
let insightsUsage: UsageState = {}
let insightsAuth: AuthInfo | null = null
let insightsTurnCount = 0

const rightPane = mountRightPane(rightHeader, rightLog, () => {
  responseView.markInterrupted()
  agentActive = false
  void window.api.session.interrupt()
})

function setEditorEditable(editable: boolean): void {
  editor.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) })
}

const editor = new EditorView({
  state: EditorState.create({
    extensions: [
      Prec.highest(keymap.of([{
        key: 'Mod-Enter',
        run: (view): boolean => {
          const rawText = view.state.doc.toString().trim()
          if (!rawText) return true
          if (handleSlashCommand(rawText, view)) return true

          const { sendText, sendImages } = extractImages(rawText)

          if (sendImages.length > MAX_IMAGE_COUNT) {
            responseView.addSystemMessage(
              `**Too many images:** this prompt contains ${sendImages.length} images (limit is ${MAX_IMAGE_COUNT}). Remove some before sending.`
            )
            return true
          }

          const textToSend = sendText.trim()

          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
          view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) })
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
        },
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
    responseView.updateToolChip(ev.toolId, ev.isError ? 'error' : 'ok')
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

window.api.session.onUsage((u) => { insightsUsage = { ...insightsUsage, ...u } })
window.api.session.onAuth((a) => { insightsAuth = a })

window.api.session.onCleared(() => {
  responseView.clear()
  rightPane.clear()
  void statusBarReady.then((sb) => sb.unfreeze())
  insightsUsage = {}
  insightsAuth = null
  insightsTurnCount = 0
  agentActive = false
  pastedImages.clear()
  imageCounter = 0
  setEditorEditable(true)
  editor.focus()
})

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

function handleSlashCommand(text: string, view: EditorView): boolean {
  const cmd = text.split(/\s+/)[0]!.toLowerCase()

  if (cmd === '/clear') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    void window.api.session.clear()
    return true
  }

  if (cmd === '/help') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    showHelpOverlay()
    return true
  }

  if (cmd === '/cost') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    rightLog.scrollTop = rightLog.scrollHeight
    rightLog.focus()
    return true
  }

  if (cmd === '/insights') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    void showInsights()
    return true
  }

  if (cmd === '/model') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    void handleModelCommand(text)
    return true
  }

  if (cmd === '/effort') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    handleEffortCommand(text)
    return true
  }

  return false
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

async function handleModelCommand(text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const config = await window.api.config.get()
  if (!config) return

  // Bare /model — list models in right pane
  if (parts.length === 1) {
    rightPane.showModelList(config.models, config.model)
    return
  }

  // /model <name> — change model; accepts full ID, full label, or substring (e.g. "sonnet")
  const requested = parts[1]!
  const q = requested.toLowerCase()
  const match = config.models.find(
    (m) =>
      m.id === requested ||
      m.label.toLowerCase() === q ||
      m.id.includes(q) ||
      m.label.toLowerCase().includes(q)
  )

  if (!match) {
    responseView.addSystemMessage(
      `**Unknown model:** \`${requested}\`\n\nAvailable models: ${config.models.map((m) => `\`${m.id}\``).join(', ')}`
    )
    return
  }

  const err = await window.api.session.setModel(match.id)
  if (err) {
    responseView.addSystemMessage(`**Failed to set model:** ${err}`)
    return
  }

  void statusBarReady.then((sb) => sb.setModel(match.id))
  responseView.addSystemMessage(`Model changed to **${match.label}** (\`${match.id}\`)`)
}

async function showInsights(): Promise<void> {
  const config = await window.api.config.get()
  const u = insightsUsage
  const auth = insightsAuth
  const turnCount = insightsTurnCount

  const lines: string[] = ['## Session Insights', '']

  // Session info
  const model = config?.model ?? 'unknown'
  const effort = config?.effort ?? 'unknown'
  const cwd = config?.cwd ?? '—'
  lines.push(`**Working directory:** \`${cwd}\``)
  lines.push(`**Model:** ${model}  `)
  lines.push(`**Effort:** ${effort}  `)
  lines.push(`**Auth:** ${auth?.label ?? config?.authMode ?? 'unknown'}  `)
  lines.push(`**Turns this session:** ${turnCount}`)
  lines.push('')

  // Usage
  lines.push('### Usage')
  lines.push('')

  const rows: [string, string][] = []

  if (u.ctxPct !== undefined) {
    const bar = usageBar(u.ctxPct)
    rows.push(['Context window', `${bar} ${u.ctxPct}%`])
  }

  if (auth?.showCost && u.costUsd !== undefined) {
    const cost = u.costUsd < 0.01 && u.costUsd > 0 ? '<$0.01' : `$${u.costUsd.toFixed(4)}`
    rows.push(['Session cost', `~${cost}`])
  }

  if (u.fiveHourStatus !== undefined || u.fiveHourPct !== undefined) {
    const val = u.fiveHourPct !== undefined
      ? `${usageBar(u.fiveHourPct)} ${u.fiveHourPct}%`
      : rateLimitSymbol(u.fiveHourStatus)
    rows.push(['5-hour rate limit', val])
  }

  if (u.sevenDayStatus !== undefined || u.sevenDayPct !== undefined) {
    const val = u.sevenDayPct !== undefined
      ? `${usageBar(u.sevenDayPct)} ${u.sevenDayPct}%`
      : rateLimitSymbol(u.sevenDayStatus)
    rows.push(['7-day rate limit', val])
  }

  if (rows.length === 0) {
    lines.push('_No usage data yet — send a prompt first._')
  } else {
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`)
  }

  responseView.addSystemMessage(lines.join('\n'))
}

function usageBar(pct: number): string {
  const filled = Math.round(pct / 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`
}

function rateLimitSymbol(status: string | undefined): string {
  if (status === 'rejected') return '✗ over limit'
  if (status === 'allowed_warning') return '! near limit'
  return '✓ within limit'
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
    <div class="help-section-title">Slash commands</div>
    <table class="help-table">
      <tr><td><code>/clear</code></td><td>New session (preserves cwd)</td></tr>
      <tr><td><code>/help</code></td><td>Show this overlay</td></tr>
      <tr><td><code>/cost</code></td><td>Scroll to usage stats</td></tr>
      <tr><td><code>/model [name]</code></td><td>Change model mid-session</td></tr>
      <tr><td><code>/effort [level]</code></td><td>Set effort (before first prompt)</td></tr>
    </table>
  `

  const note = document.createElement('p')
  note.className = 'help-note'
  note.textContent = 'Skill commands (/diagnose, /grill-me, etc.) pass through to Claude.'

  const closeBtn = document.createElement('button')
  closeBtn.className = 'help-close-btn'
  closeBtn.type = 'button'
  closeBtn.textContent = 'Close  (Esc)'
  closeBtn.addEventListener('click', () => overlay.remove())

  modal.append(title, kbSection, cmdSection, note, closeBtn)
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
