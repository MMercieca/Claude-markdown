import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; interrupted?: boolean }

interface Props {
  turns: Turn[]
  streaming: string | null
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
            <pre className="user-text">{turn.text}</pre>
          ) : (
            <>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
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
          <pre className="streaming-text">{streaming}</pre>
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
