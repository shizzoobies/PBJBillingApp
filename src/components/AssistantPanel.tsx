import { useConversation } from '@elevenlabs/react'
import { Lightbulb, Mic, PhoneOff, Send, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import assistantAvatar from '../assets/pbj-assistant.png'
import {
  assistantChatRequest,
  assistantClearHistory,
  assistantDismissSuggestion,
  assistantEmailReportSend,
  assistantFeatureRequestSend,
  assistantHistoryRequest,
  assistantInsightsRequest,
  assistantRunAction,
  fetchVoiceSignedUrl,
  type AssistantActionProposal,
  type AssistantChatMessage,
  type AssistantEmailReportDraft,
  type AssistantFeatureRequestDraft,
  type AssistantSuggestion,
} from '../lib/api'

type ThreadEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'draft'; draft: AssistantFeatureRequestDraft; status: 'pending' | 'sent' | 'dismissed' }
  | {
      kind: 'emailReport'
      draft: AssistantEmailReportDraft
      status: 'pending' | 'sent' | 'dismissed'
      result?: string
    }
  | {
      kind: 'action'
      action: AssistantActionProposal
      status: 'pending' | 'done' | 'dismissed'
      result?: string
    }

const GREETING =
  'Hi! Ask me anything about the app — how to do something, whether a ' +
  "feature exists, or what's set up for a client. I can also set things up " +
  'for you (recurring tasks, client assignments) or send Alex a feature request.'

/**
 * Owner-only floating AI assistant. The chat history is persisted server-side
 * (loaded on open, saved per turn) so it survives reloads and follows the
 * owner across devices. Replies stream in. Feature-request drafts and action
 * proposals render as confirmation cards that only act when the owner clicks.
 */
export function AssistantPanel() {
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<ThreadEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [suggestions, setSuggestions] = useState<AssistantSuggestion[]>([])
  const insightsLoadedRef = useRef(false)
  const historyLoadedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // --- Voice (ElevenLabs) ---
  const [voiceError, setVoiceError] = useState('')
  const [voiceConnecting, setVoiceConnecting] = useState(false)
  const conversation = useConversation({
    onConnect: () => setVoiceError(''),
    onError: (message: unknown) =>
      setVoiceError(typeof message === 'string' && message ? message : 'Voice error — try again.'),
    onMessage: (payload: unknown) => {
      // Surface spoken turns as text in the thread when the shape is known.
      const source = (payload as { source?: string })?.source
      const text = (payload as { message?: string })?.message
      if (typeof text === 'string' && text.trim() && (source === 'user' || source === 'ai')) {
        setThread((current) => [
          ...current,
          { kind: 'message', role: source === 'user' ? 'user' : 'assistant', text },
        ])
      }
    },
  })
  const voiceStatus = conversation.status // 'connected' | 'connecting' | 'disconnected'
  const voiceActive = voiceStatus === 'connected' || voiceStatus === 'connecting'

  const startVoice = async () => {
    if (voiceActive || voiceConnecting) return
    setVoiceError('')
    setVoiceConnecting(true)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      const { signedUrl } = await fetchVoiceSignedUrl()
      await conversation.startSession({ signedUrl })
    } catch (error) {
      setVoiceError(
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'Microphone access was blocked — allow it in your browser to talk.'
          : error instanceof Error
            ? error.message
            : 'Could not start voice — try again.',
      )
    } finally {
      setVoiceConnecting(false)
    }
  }

  const stopVoice = async () => {
    try {
      await conversation.endSession()
    } catch {
      // Already disconnected — nothing to do.
    }
  }

  // End any live voice session when the panel closes or unmounts so the mic
  // is never left hot in the background.
  useEffect(() => {
    if (!open && voiceActive) conversation.endSession()
  }, [open, voiceActive, conversation])
  useEffect(
    () => () => {
      conversation.endSession()
    },
    [conversation],
  )

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Load the persisted conversation once, on first open.
  useEffect(() => {
    if (!open || historyLoadedRef.current) return
    historyLoadedRef.current = true
    assistantHistoryRequest()
      .then((result) => {
        if (result.messages.length > 0) {
          setThread(
            result.messages.map((message) => ({
              kind: 'message',
              role: message.role,
              text: message.text,
            })),
          )
        }
      })
      .catch(() => {
        // No saved history is fine — the panel works from empty.
      })
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
  }, [thread, busy, streamText])

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
    setStreamText('')
    try {
      const result = await assistantChatRequest(historyForApi(nextThread), (delta) =>
        setStreamText((current) => current + delta),
      )
      setThread((current) => {
        const updated: ThreadEntry[] = [
          ...current,
          { kind: 'message', role: 'assistant', text: result.reply },
        ]
        if (result.featureRequestDraft) {
          updated.push({ kind: 'draft', draft: result.featureRequestDraft, status: 'pending' })
        }
        if (result.emailReportDraft) {
          updated.push({ kind: 'emailReport', draft: result.emailReportDraft, status: 'pending' })
        }
        for (const action of result.actionProposals ?? []) {
          updated.push({ kind: 'action', action, status: 'pending' })
        }
        return updated
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Something went wrong — try again in a moment.'
      setThread((current) => [...current, { kind: 'message', role: 'assistant', text: message }])
    } finally {
      setStreamText('')
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
            : 'Recorded in the activity feed — but I couldn’t confirm the email went out, so check with Alex if it’s urgent.',
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

  const resolveEmailReport = async (index: number, choice: 'send' | 'dismiss') => {
    const entry = thread[index]
    if (!entry || entry.kind !== 'emailReport' || entry.status !== 'pending') return
    if (choice === 'dismiss') {
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'emailReport' ? { ...item, status: 'dismissed' } : item,
        ),
      )
      return
    }
    setBusy(true)
    try {
      const result = await assistantEmailReportSend(entry.draft)
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'emailReport'
            ? { ...item, status: result.emailSent ? 'sent' : 'pending', result: result.message }
            : item,
        ),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not email it — try again.'
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'emailReport' ? { ...item, result: message } : item,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const resolveAction = async (index: number, choice: 'run' | 'dismiss') => {
    const entry = thread[index]
    if (!entry || entry.kind !== 'action' || entry.status !== 'pending') return
    if (choice === 'dismiss') {
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'action' ? { ...item, status: 'dismissed' } : item,
        ),
      )
      return
    }
    setBusy(true)
    try {
      const result = await assistantRunAction(entry.action)
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'action'
            ? { ...item, status: result.ok ? 'done' : 'pending', result: result.message }
            : item,
        ),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not run that — try again.'
      setThread((current) =>
        current.map((item, i) =>
          i === index && item.kind === 'action' ? { ...item, result: message } : item,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const clearConversation = async () => {
    setThread([])
    try {
      await assistantClearHistory()
    } catch {
      // Best-effort; the local thread is already cleared.
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
        <img src={assistantAvatar} alt="" className="assistant-fab-avatar" />
      </button>
      {open ? (
        <section className="assistant-panel" aria-label="AI assistant">
          <header className="assistant-panel-header">
            <div className="assistant-panel-title">
              <img src={assistantAvatar} alt="" className="assistant-title-avatar" />
              <strong>Assistant</strong>
              <span>Owner only</span>
            </div>
            <div className="assistant-panel-actions">
              <button
                type="button"
                className={voiceActive ? 'assistant-mic-btn is-active' : 'assistant-mic-btn'}
                aria-label={voiceActive ? 'End voice call' : 'Talk to the assistant'}
                title={voiceActive ? 'End voice' : 'Talk'}
                disabled={voiceConnecting}
                onClick={() => (voiceActive ? void stopVoice() : void startVoice())}
              >
                {voiceActive ? <PhoneOff size={15} /> : <Mic size={15} />}
              </button>
              {thread.length > 0 ? (
                <button
                  type="button"
                  className="assistant-panel-clear"
                  aria-label="Clear conversation"
                  title="Clear conversation"
                  disabled={busy}
                  onClick={() => void clearConversation()}
                >
                  <Trash2 size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="assistant-panel-close"
                aria-label="Close assistant"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
          </header>
          <div className="assistant-thread" ref={scrollRef}>
            <div className="assistant-bubble assistant-bubble-bot">{GREETING}</div>
            {voiceActive || voiceConnecting || voiceError ? (
              <div
                className={`assistant-voice-bar${conversation.isSpeaking ? ' is-speaking' : ''}${voiceError ? ' is-error' : ''}`}
              >
                <img src={assistantAvatar} alt="" className="assistant-voice-avatar" />
                <span className="assistant-voice-status">
                  {voiceError
                    ? voiceError
                    : voiceConnecting || voiceStatus === 'connecting'
                      ? 'Connecting…'
                      : conversation.isSpeaking
                        ? 'Speaking…'
                        : 'Listening…'}
                </span>
                {voiceActive ? (
                  <button
                    type="button"
                    className="assistant-voice-end"
                    onClick={() => void stopVoice()}
                  >
                    End
                  </button>
                ) : null}
              </div>
            ) : null}
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
              if (entry.kind === 'draft') {
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
              }
              if (entry.kind === 'emailReport') {
                return (
                  <div key={index} className="assistant-draft-card assistant-action-card">
                    <p className="assistant-draft-kicker">Email this report</p>
                    <strong>{entry.draft.subject}</strong>
                    {entry.status === 'pending' ? (
                      <>
                        <div className="assistant-draft-actions">
                          <button
                            type="button"
                            className="primary-action"
                            disabled={busy}
                            onClick={() => void resolveEmailReport(index, 'send')}
                          >
                            Email it to me
                          </button>
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={busy}
                            onClick={() => void resolveEmailReport(index, 'dismiss')}
                          >
                            No thanks
                          </button>
                        </div>
                        {entry.result ? (
                          <p className="assistant-draft-status">{entry.result}</p>
                        ) : null}
                      </>
                    ) : (
                      <p className="assistant-draft-status">
                        {entry.status === 'sent' ? `${entry.result ?? 'Emailed'} ✓` : 'Not emailed'}
                      </p>
                    )}
                  </div>
                )
              }
              return (
                <div key={index} className="assistant-draft-card assistant-action-card">
                  <p className="assistant-draft-kicker">{entry.action.label}</p>
                  <p>{entry.action.summary}</p>
                  {entry.status === 'pending' ? (
                    <>
                      <div className="assistant-draft-actions">
                        <button
                          type="button"
                          className="primary-action"
                          disabled={busy}
                          onClick={() => void resolveAction(index, 'run')}
                        >
                          Run it
                        </button>
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={busy}
                          onClick={() => void resolveAction(index, 'dismiss')}
                        >
                          Cancel
                        </button>
                      </div>
                      {entry.result ? (
                        <p className="assistant-draft-status">{entry.result}</p>
                      ) : null}
                    </>
                  ) : (
                    <p className="assistant-draft-status">
                      {entry.status === 'done' ? `${entry.result ?? 'Done'} ✓` : 'Cancelled'}
                    </p>
                  )}
                </div>
              )
            })}
            {busy ? (
              <div className="assistant-bubble assistant-bubble-bot">
                {streamText || 'Thinking…'}
              </div>
            ) : null}
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
