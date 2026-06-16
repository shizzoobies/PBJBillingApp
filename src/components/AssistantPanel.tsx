import { useConversation } from '@elevenlabs/react'
import { FileText, Lightbulb, Mic, PhoneOff, Send, Trash2, X } from 'lucide-react'
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
  fetchPendingFeatureRequests,
  fetchPendingReports,
  fetchPendingVoiceActions,
  fetchVoiceSignedUrl,
  resolvePendingFeatureRequest,
  resolvePendingReport,
  resolvePendingVoiceAction,
  type AssistantActionProposal,
  type AssistantChatMessage,
  type AssistantEmailReportDraft,
  type AssistantFeatureRequestDraft,
  type AssistantReport,
  type AssistantSuggestion,
} from '../lib/api'
import { AssistantReportModal } from './AssistantReportModal'

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
  | { kind: 'report'; report: AssistantReport }

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
  const [activeReport, setActiveReport] = useState<AssistantReport | null>(null)
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
      const { signedUrl, dynamicVariables } = await fetchVoiceSignedUrl()
      await conversation.startSession({ signedUrl, dynamicVariables })
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

  // While a voice call is live, poll for action proposals the agent filed so
  // they appear as confirm cards mid-conversation. The agent can only ever
  // PROPOSE — these cards run nothing until the owner taps "Run it" (the
  // same owner-session /api/assistant/action gate the text assistant uses).
  const seenProposalIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!voiceActive) return
    const poll = async () => {
      try {
        const { proposals } = await fetchPendingVoiceActions()
        const fresh = proposals.filter((p) => !seenProposalIdsRef.current.has(p.id))
        if (fresh.length === 0) return
        for (const p of fresh) seenProposalIdsRef.current.add(p.id)
        setThread((current) => [
          ...current,
          ...fresh.map((p) => ({ kind: 'action' as const, action: p, status: 'pending' as const })),
        ])
      } catch {
        // Polling is best-effort; the next tick retries.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => window.clearInterval(timer)
  }, [voiceActive])

  // During a voice call, poll for reports the agent generated and pop them
  // into the report modal (the voice surface has no screen of its own).
  const seenReportIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!voiceActive) return
    const poll = async () => {
      try {
        const { reports } = await fetchPendingReports()
        const fresh = reports.filter((r) => !seenReportIdsRef.current.has(r.id))
        if (fresh.length === 0) return
        for (const r of fresh) {
          seenReportIdsRef.current.add(r.id)
          void resolvePendingReport(r.id).catch(() => {})
        }
        setThread((current) => [
          ...current,
          ...fresh.map((r) => ({ kind: 'report' as const, report: r.report })),
        ])
        setActiveReport(fresh[fresh.length - 1].report)
      } catch {
        // Best-effort; the next tick retries.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => window.clearInterval(timer)
  }, [voiceActive])

  // During a voice call, poll for feature-request drafts the agent created and
  // show each as the usual confirm card (sending still needs the owner's tap).
  const seenFeatureReqIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!voiceActive) return
    const poll = async () => {
      try {
        const { drafts } = await fetchPendingFeatureRequests()
        const fresh = drafts.filter((d) => !seenFeatureReqIdsRef.current.has(d.id))
        if (fresh.length === 0) return
        for (const d of fresh) {
          seenFeatureReqIdsRef.current.add(d.id)
          void resolvePendingFeatureRequest(d.id).catch(() => {})
        }
        setThread((current) => [
          ...current,
          ...fresh.map((d) => ({ kind: 'draft' as const, draft: d.draft, status: 'pending' as const })),
        ])
      } catch {
        // Best-effort; the next tick retries.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => window.clearInterval(timer)
  }, [voiceActive])

  // End any live voice session when the panel closes or unmounts so the mic
  // is never left hot in the background. Both effects go through a ref:
  // useConversation returns a NEW object identity every render, so depending
  // on it directly would re-run the cleanup mid-call and hang up the moment
  // the session connects (status change → re-render → teardown → endSession).
  const conversationRef = useRef(conversation)
  useEffect(() => {
    conversationRef.current = conversation
  })
  useEffect(() => {
    if (!open) conversationRef.current.endSession()
  }, [open])
  useEffect(
    () => () => {
      conversationRef.current.endSession()
    },
    [],
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
        if (result.report) {
          updated.push({ kind: 'report', report: result.report })
        }
        return updated
      })
      if (result.report) setActiveReport(result.report)
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
    // Voice-filed proposals also live server-side until handled; clear them so
    // they don't re-appear on the next poll. No-op for text-chat proposals.
    void resolvePendingVoiceAction(entry.action.id).catch(() => {})
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
              if (entry.kind === 'report') {
                return (
                  <div key={index} className="assistant-draft-card assistant-report-card">
                    <p className="assistant-draft-kicker">
                      <FileText size={12} /> Report ready
                    </p>
                    <strong>{entry.report.title}</strong>
                    {entry.report.subtitle ? <p>{entry.report.subtitle}</p> : null}
                    <div className="assistant-draft-actions">
                      <button
                        type="button"
                        className="primary-action"
                        onClick={() => setActiveReport(entry.report)}
                      >
                        Open report
                      </button>
                    </div>
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
      {activeReport ? (
        <AssistantReportModal report={activeReport} onClose={() => setActiveReport(null)} />
      ) : null}
    </>
  )
}
