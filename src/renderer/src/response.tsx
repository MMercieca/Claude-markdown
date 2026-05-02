import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const onCopy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const text = preRef.current?.textContent ?? ''
    e.currentTarget.blur()
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="code-block-wrap">
      <button type="button" className="code-copy-btn" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  )
}

const markdownComponents: Components = { pre: CodeBlock }

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; interrupted?: boolean }

interface Props {
  turns: Turn[]
  streaming: string | null
}

// While streaming, if the buffer contains an opened-but-unclosed ``` fence,
// append a synthetic closer so remark parses everything from the opener
// onward as a code block instead of a paragraph. Avoids the worst flicker
// case before the model emits the closing fence.
function closeOpenFence(buf: string): string {
  const fenceLines = buf.match(/^```/gm)?.length ?? 0
  return fenceLines % 2 === 1 ? buf + '\n```' : buf
}

function Transcript({ turns, streaming }: Props): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, streaming])

  return (
    <>
      {turns.map((turn, i) => (
        <div key={i} className={`turn turn-${turn.role}`}>
          {turn.role === 'user' ? (
            <div className="user-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {turn.text}
              </ReactMarkdown>
            </div>
          ) : (
            <>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {turn.text}
              </ReactMarkdown>
              {turn.interrupted && <div className="interrupted">[interrupted]</div>}
            </>
          )}
        </div>
      ))}
      {streaming !== null && (
        <div className="turn turn-assistant streaming">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {closeOpenFence(streaming)}
          </ReactMarkdown>
        </div>
      )}
      <div ref={endRef} />
    </>
  )
}

export class ResponseView {
  private root: Root
  private turns: Turn[] = []
  private streaming: string | null = null

  constructor(container: HTMLElement) {
    this.root = createRoot(container)
    this.render()
  }

  private render(): void {
    this.root.render(<Transcript turns={this.turns} streaming={this.streaming} />)
  }

  addUserTurn(text: string): void {
    this.turns.push({ role: 'user', text })
    this.render()
  }

  startAssistantTurn(): void {
    this.streaming = ''
    this.render()
  }

  appendDelta(delta: string): void {
    this.streaming = (this.streaming ?? '') + delta
    this.render()
  }

  finishAssistantTurn(): void {
    if (this.streaming !== null) {
      this.turns.push({ role: 'assistant', text: this.streaming })
      this.streaming = null
      this.render()
    }
  }

  markInterrupted(): void {
    if (this.streaming !== null) {
      this.turns.push({ role: 'assistant', text: this.streaming, interrupted: true })
      this.streaming = null
      this.render()
    }
  }
}
