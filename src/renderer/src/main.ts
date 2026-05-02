import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import 'highlight.js/styles/github.css'
import { ResponseView } from './response'
import { mountStatusBar } from './status-bar'

const leftCol = document.getElementById('left-col') as HTMLElement
const responsePane = document.getElementById('response-pane') as HTMLElement
const responseContent = document.getElementById('response-content') as HTMLElement
const statusBar = document.getElementById('status-bar') as HTMLElement
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

const editableCompartment = new Compartment()

// Tracks whether the agent is currently generating. Read by both the Escape
// keymap and the onDone handler; written by the Mod-Enter keymap and onDone.
let agentActive = false

function setEditorEditable(editable: boolean): void {
  editor.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) })
}

const editor = new EditorView({
  state: EditorState.create({
    extensions: [
      Prec.highest(keymap.of([{
        key: 'Mod-Enter',
        run: (view): boolean => {
          const text = view.state.doc.toString().trim()
          if (!text) return true
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
          view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) })
          agentActive = true
          responseView.addUserTurn(text)
          responseView.startAssistantTurn()
          void statusBarReady.then((sb) => sb.freeze())
          void window.api.session.send(text)
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

// ── Session streaming ───────────────────────────────────────────────────────

window.api.session.onDelta((delta) => {
  responseView.appendDelta(delta)
  responsePane.scrollTop = responsePane.scrollHeight
})

window.api.session.onDone(() => {
  responseView.finishAssistantTurn()
  agentActive = false
  setEditorEditable(true)
  editor.focus()
})

// Escape is handled at the document level because the editor is non-editable
// while the agent is active and won't dispatch keymaps in that state.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && agentActive) {
    e.preventDefault()
    responseView.markInterrupted()
    agentActive = false
    void window.api.session.interrupt()
  }
})
