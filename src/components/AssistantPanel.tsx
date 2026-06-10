import { Lightbulb, Send, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  assistantChatRequest,
  assistantDismissSuggestion,
  assistantFeatureRequestSend,
  assistantInsightsRequest,
  type AssistantChatMessage,
  type AssistantFeatureRequestDraft,
  type AssistantSuggestion,
} from '../lib/api'

type ThreadEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'draft'; draft: AssistantFeatureRequestDraft; status: 'pending' | 'sent' | 'dismissed' }

const GREETING =
  'Hi! Ask me anything about the app — how to do something, whether a ' +
  "feature exists, or what's set up for a client. If we can't do it yet, " +
  'I can send Alex a feature request.'

/**
 * Owner-only floating AI assistant. The chat history lives in component
 * state (capped server-side); feature-request drafts render as a
 * confirmation card and only send when the owner clicks Send to Alex.
 */
export function AssistantPanel() {
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<ThreadEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<AssistantSuggestion[]>([])
  const insightsLoadedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Watch-and-learn cards: fetched once per panel mount, on first open.
  // Detection is deterministic and server-side; dismissed keys never return.
  useEffect(() => {
    if (!open || insightsLoadedRef.current) return
    insightsLoadedRef.current = true
    assistantInsightsRequest()
      .then((result) => setSuggestions(result.suggestions))
      .catch(() => {
        // Insights are a bonus — chat works fine without them.
      })
  }, [open])

  const dismissSuggestion = (key: string) => {
    setSuggestions((current) => current.filter((item) => item.key !== key))
    void assistantDismissSuggestion(key).catch(() => {
      // Best-effort: if persisting fails it may reappear next session.
    })
  }

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [thread, busy])

  const historyForApi = (entries: ThreadEntry[]): AssistantChatMessage[] =>
    entries
      .filter((entry): entry is Extract<ThreadEntry, { kind: 'message' }> => entry.kind === 'message')
      .map((entry) => ({ role: entry.role, text: entry.text }))

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const nextThread: ThreadEntry[] = [...thread, { kind: 'message', role: 'user', text }]
    setThread(nextThread)
    setBusy(true)
    try {
      const result = await assistantChatRequest(historyForApi(nextThread))
      setThread((current) => {
        const updated: ThreadEntry[] = [
          ...current,
          { kind: 'message', role: 'assistant', text: result.reply },
        ]
        if (result.featureRequestDraft) {
          updated.push({ kind: 'draft', draft: result.featureRequestDraft, status: 'pending' })
        }
        return updated
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Something went wrong — try again in a moment.'
      setThread((current) => [...current, { kind: 'message', role: 'assistant', text: message }])
    } finally {
      setBusy(false)
    }
  }

  const resolveDraft = async (index: number, action: 'send' | 'dismiss') => {
    const entry = thread[index]
    if (!entry || entry.kind !== 'draft' || entry.status !== 'pending') return
    if (action === 'dismiss') {
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'draft' ? { ...item, status: 'dismissed' } : item,
        ),
      )
      return
    }
    setBusy(true)
    try {
      const result = await assistantFeatureRequestSend(entry.draft)
      setThread((current) => {
        const updated = current.map((item, i) =>
          i === index && item.kind === 'draft' ? { ...item, status: 'sent' as const } : item,
        )
        updated.push({
          kind: 'message',
          role: 'assistant',
          text: result.emailSent
            ? 'Sent! Alex will get the request by email, and it’s logged in the activity feed.'
            : 'Recorded! Email isn’t configured on this server, but the request is logged in the activity feed.',
        })
        return updated
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not send — try again in a moment.'
      setThread((current) => [...current, { kind: 'message', role: 'assistant', text: message }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="assistant-fab"
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles size={20} />
      </button>
      {open ? (
        <section className="assistant-panel" aria-label="AI assistant">
          <header className="assistant-panel-header">
            <div className="assistant-panel-title">
              <Sparkles size={15} />
              <strong>Assistant</strong>
              <span>Owner only</span>
            </div>
            <button
              type="button"
              className="assistant-panel-close"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <div className="assistant-thread" ref={scrollRef}>
            <div className="assistant-bubble assistant-bubble-bot">{GREETING}</div>
            {suggestions.map((suggestion) => (
              <div key={suggestion.key} className="assistant-insight-card">
                <p className="assistant-insight-kicker">
                  <Lightbulb size={12} /> Noticed something
                </p>
                <strong>{suggestion.title}</strong>
                <p>{suggestion.body}</p>
                <div className="assistant-draft-actions">
                  <Link
                    to={suggestion.link}
                    className="secondary-action"
                    onClick={() => setOpen(false)}
                  >
                    Take me there
                  </Link>
                  <button
                    type="button"
                    className="assistant-insight-dismiss"
                    onClick={() => dismissSuggestion(suggestion.key)}
                  >
                    Don’t show again
                  </button>
                </div>
              </div>
            ))}
            {thread.map((entry, index) => {
              if (entry.kind === 'message') {
                return (
                  <div
                    key={index}
                    className={
                      entry.role === 'user'
                        ? 'assistant-bubble assistant-bubble-user'
                        : 'assistant-bubble assistant-bubble-bot'
                    }
                  >
                    {entry.text}
                  </div>
                )
              }
              return (
                <div key={index} className="assistant-draft-card">
                  <p className="assistant-draft-kicker">Feature request for Alex</p>
                  <strong>{entry.draft.title}</strong>
                  <p>{entry.draft.description}</p>
                  {entry.status === 'pending' ? (
                    <div className="assistant-draft-actions">
                      <button
                        type="button"
                        className="primary-action"
                        disabled={busy}
                        onClick={() => void resolveDraft(index, 'send')}
                      >
                        Send to Alex
                      </button>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={busy}
                        onClick={() => void resolveDraft(index, 'dismiss')}
                      >
                        Don’t send
                      </button>
                    </div>
                  ) : (
                    <p className="assistant-draft-status">
                      {entry.status === 'sent' ? 'Sent to Alex ✓' : 'Not sent'}
                    </p>
                  )}
                </div>
              )
            })}
            {busy ? <div className="assistant-bubble assistant-bubble-bot">Thinking…</div> : null}
          </div>
          <form
            className="assistant-input-row"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder="Ask about the app…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <button type="submit" aria-label="Send" disabled={busy || input.trim() === ''}>
              <Send size={16} />
            </button>
          </form>
        </section>
      ) : null}
    </>
  )
}
