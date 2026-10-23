import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ListSearch } from '../components/ListSearch'
import { LetterPreviewModal } from '../components/LetterPreviewModal'
import { BoldBar, PlaceholderChips } from '../components/letters/LetterEditorKit'
import {
  esignFieldCount,
  insertPlaceholder,
  isBoldShortcut,
  toggleBold,
  unknownPlaceholderSentence,
} from '../components/letters/letterEditing'
import { SaveBadge } from '../components/SectionKit'
import { RecipientPicker } from '../components/RecipientPicker'
import { recipientListLabel } from '../lib/recipientSelection'
import type { InvoiceRecipientDetail } from '../lib/utils'
import {
  createLetterRequest,
  deleteLetterRequest,
  fetchLetterTemplate,
  listLetterSendsRequest,
  listLettersRequest,
  renameLetterRequest,
  saveLetterTemplate,
  sendLettersRequest,
} from '../lib/api'
import type { SaveFlashState } from '../lib/useSaveFlash'
import { firmToday } from '../../lib/firm-time.js'
import { reconcileCoveredResults } from '../../lib/letter-batch-cover.js'
import { LETTER_IN_FLIGHT_MS } from '../../lib/letter-in-flight.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients } from '../../lib/invoice-recipients.js'
import { retiredSentence, templateWarnings } from '../../lib/letter-template.js'
import { withoutTeamAddresses } from '../../lib/recipient-addresses.js'
import {
  ApiError,
  type Client,
  type LetterListState,
  type LetterSendRecord,
  type LetterSendResult,
  type LetterSummary,
  type LetterTemplateState,
} from '../lib/types'

/** Clients are sent in chunks of this many so the page can show progress. */
const SEND_CHUNK = 10

/**
 * A 1099 engagement letter is what a newly signed (onboarding) client needs as much as
 * an established one, so both are listed by default; inactive and proposal-stage
 * clients sit behind the checkbox.
 */
const SHOWN_BY_DEFAULT = new Set(['active', 'onboarding'])

/** What a client's row says when an address ticked in its picker is no longer on file (featreq-34627da1). */
const STALE_RECIPIENT_SENTENCE = 'An address is no longer on file - click Change to pick again.'

/** The longest name a letter may have (the server refuses longer). */
const NAME_MAX = 80

type Field = 'subject' | 'emailBody' | 'letterBody'
type BodyField = 'emailBody' | 'letterBody'

/** "2026-10-08" -> "Oct 8, 2026" (the firm's calendar day, not the browser's). */
function dayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

type PickerRow = {
  client: Client
  contactName: string
  to: string[]
  /** The addresses Send may use, each named: what the recipient picker lists. */
  details: InvoiceRecipientDetail[]
  /** How many of the client's addresses are a team member's: Send never uses them. */
  teamHidden: number
  /** Why this client cannot be picked, or null when it can. */
  blocked: string | null
  pills: string[]
  lastSent: string
}

/**
 * Letters (featreq-5e195707) - the engagement letters. She keeps a list of saved
 * letters, each one email and one letter written once with {{placeholders}} and
 * **bold**; she picks a letter, picks the clients, and Send gives each of them the
 * email with the letter attached as a PDF. Replies go to the invoice mailbox.
 * Everything a letter says about a client is filled in by the server, from the
 * SAVED letter, with the same code Preview shows - so Preview and Send are
 * disabled while the editor holds unsaved text.
 */
export function LettersPage() {
  const { ownerMode, data, dataRefreshCount } = useAppContext()

  // The saved letters, and the one being edited, previewed and sent.
  const [letters, setLetters] = useState<LetterSummary[] | null>(null)
  const [letterId, setLetterId] = useState<string | null>(null)
  const [listError, setListError] = useState('')
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)

  const [state, setState] = useState<LetterTemplateState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [subject, setSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [letterBody, setLetterBody] = useState('')
  const [saveState, setSaveState] = useState<SaveFlashState>('idle')
  const [saveError, setSaveError] = useState('')

  const [sends, setSends] = useState<LetterSendRecord[]>([])
  // The clock a "still sending" row is judged against: read when the log arrives and once a minute.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const [query, setQuery] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Why a tick was refused or what a master's tick unticked out of sight.
  const [coveredNote, setCoveredNote] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)

  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState('')
  const [sendError, setSendError] = useState('')
  const [results, setResults] = useState<LetterSendResult[]>([])
  // featreq-34627da1: the clients whose recipient picker she changed - the on-file
  // addresses left ticked and the ones added for this send only - and whose picker is open.
  const [recipientChoices, setRecipientChoices] = useState<Record<string, { to: string[]; extra: string[] }>>({})
  const [choosingFor, setChoosingFor] = useState<string | null>(null)

  const subjectRef = useRef<HTMLInputElement>(null)
  const emailBodyRef = useRef<HTMLTextAreaElement>(null)
  const letterBodyRef = useRef<HTMLTextAreaElement>(null)
  // The box she last put the cursor in (null once she is in the subject): the B buttons act on
  // the box that holds her selection, not only on the box their own toolbar sits above.
  const lastFocusedRef = useRef<BodyField | null>(null)

  // The stored letter behind the boxes, only once it is the letter chosen (an answer for
  // a letter she has since left is not it).
  const saved = state && state.template.id === letterId ? state.template : undefined
  const dirty =
    saved !== undefined &&
    (subject !== saved.subject || emailBody !== saved.emailBody || letterBody !== saved.letterBody)
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  /** Which letter's text the three boxes hold: another letter's always replaces it. */
  const loadedIdRef = useRef<string | null>(null)
  const letterIdRef = useRef<string | null>(null)
  useEffect(() => {
    letterIdRef.current = letterId
  }, [letterId])

  const adopt = useCallback((next: LetterTemplateState, { overwriteText }: { overwriteText: boolean }) => {
    setState(next)
    if (overwriteText || loadedIdRef.current !== next.template.id) {
      loadedIdRef.current = next.template.id
      setSubject(next.template.subject)
      setEmailBody(next.template.emailBody)
      setLetterBody(next.template.letterBody)
    }
  }, [])

  /** Take a list of letters; keep the chosen one while it is still there (or `prefer`), else the first. */
  const applyList = useCallback((next: LetterListState, prefer?: string | null) => {
    setLetters(next.letters)
    setListError('')
    const want = prefer === undefined ? letterIdRef.current : prefer
    const keep = next.letters.some((letter) => letter.id === want) ? want : (next.letters[0]?.id ?? null)
    letterIdRef.current = keep ?? null
    setLetterId(keep ?? null)
  }, [])

  const refreshList = useCallback(
    async (prefer?: string | null) => {
      try {
        applyList(await listLettersRequest(), prefer)
      } catch (err) {
        setListError(err instanceof ApiError ? err.message : 'Could not load the letters.')
      }
    },
    [applyList],
  )

  const refreshSends = useCallback(async () => {
    const id = letterIdRef.current
    if (!id) return
    try {
      const rows = await listLetterSendsRequest(id)
      if (letterIdRef.current === id) setSends(rows)
    } catch {
      // The log is context for the table; a failed read leaves what was on screen.
    }
  }, [])

  // The list; again when another tab or session changes data.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listLettersRequest()
      .then((next) => {
        if (!cancelled) applyList(next)
      })
      .catch((err) => {
        if (!cancelled) setListError(err instanceof ApiError ? err.message : 'Could not load the letters.')
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, dataRefreshCount, applyList])

  // The chosen letter and its send log; again when another tab or session changes data.
  useEffect(() => {
    if (!ownerMode || !letterId) return
    let cancelled = false
    void fetchLetterTemplate(letterId)
      .then((next) => {
        if (cancelled) return
        setLoadError('')
        adopt(next, { overwriteText: !dirtyRef.current })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load the letter.')
      })
    void listLetterSendsRequest(letterId)
      .then((rows) => {
        if (!cancelled) setSends(rows)
      })
      .catch(() => {
        if (!cancelled) setSends([])
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, letterId, dataRefreshCount, adopt])

  const warnings = useMemo(
    () => templateWarnings({ subject, emailBody, letterBody }),
    [subject, emailBody, letterBody],
  )

  const current = letters?.find((letter) => letter.id === letterId) ?? null
  const letterName = saved?.name ?? current?.name ?? ''

  /** Leaving unsaved text asks first. */
  const okToLeave = () =>
    !dirty || window.confirm(`"${letterName}" has changes that are not saved. Leave them and go on?`)

  /** A different letter starts clean: its own results, log and save state. */
  const resetForLetter = () => {
    setResults([])
    setRecipientChoices({})
    setSendError('')
    setSaveError('')
    setSaveState('idle')
    setSends([])
  }

  const choose = (id: string) => {
    if (id === letterId) return
    if (!okToLeave()) return
    setNaming(null)
    resetForLetter()
    letterIdRef.current = id
    setLetterId(id)
  }

  const save = async () => {
    if (!letterId) return
    setSaveState('saving')
    setSaveError('')
    try {
      const next = await saveLetterTemplate(letterId, { subject, emailBody, letterBody })
      adopt(next, { overwriteText: true })
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1800)
      void refreshList()
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the letter.')
    }
  }

  /* ---- the list: new, rename, delete -------------------------------------- */

  const startNaming = (mode: 'new' | 'rename') => {
    setNaming(mode)
    setNameDraft(mode === 'rename' ? letterName : '')
    setListError('')
  }

  const submitName = async () => {
    const name = nameDraft.trim()
    if (!name) return
    if (naming === 'new' && !okToLeave()) return
    setNameBusy(true)
    setListError('')
    try {
      if (naming === 'new') {
        const created = await createLetterRequest(name)
        resetForLetter()
        adopt(created, { overwriteText: true })
        await refreshList(created.template.id)
      } else if (naming === 'rename' && letterId) {
        // Only the name changes: unsaved text in the boxes stays as it is.
        setState(await renameLetterRequest(letterId, name))
        await refreshList()
      }
      setNaming(null)
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'Could not save the name.')
    } finally {
      setNameBusy(false)
    }
  }

  const remove = async () => {
    if (!current) return
    const ok = window.confirm(`Delete the letter "${current.name}"? This cannot be undone.`)
    if (!ok) return
    setListError('')
    try {
      await deleteLetterRequest(current.id)
      loadedIdRef.current = null
      setState(null)
      resetForLetter()
      await refreshList(null)
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'Could not delete the letter.')
    }
  }

  /* ---- the editor ---------------------------------------------------------- */

  const values = { subject, emailBody, letterBody }
  const setters = { subject: setSubject, emailBody: setEmailBody, letterBody: setLetterBody }
  const refs = { subject: subjectRef, emailBody: emailBodyRef, letterBody: letterBodyRef }

  const insertToken = (field: Field, key: string) =>
    insertPlaceholder(() => refs[field].current, values[field], key, setters[field])

  /**
   * The B button and Ctrl/Cmd+B: `**` around the selection (lib/letter-bold.js), or off again.
   * The box that was focused last wins when words are selected in it; otherwise the box the
   * button belongs to.
   */
  const applyBold = (field: BodyField) => {
    const last = lastFocusedRef.current
    const lastBox = last && last !== field ? refs[last].current : null
    const target: BodyField = last && lastBox && lastBox.selectionStart !== lastBox.selectionEnd ? last : field
    toggleBold(() => refs[target].current, values[target], setters[target])
  }

  const boldShortcut = (event: KeyboardEvent<HTMLTextAreaElement>, field: BodyField) => {
    if (isBoldShortcut(event)) {
      event.preventDefault()
      applyBold(field)
    }
  }

  /* ---- the picker -------------------------------------------------------- */

  const clients = useMemo(() => data.clients ?? [], [data.clients])
  // The addresses of the app's user accounts (the reply-to mailbox left out) are never mailed.
  const teamAddresses = state?.teamAddresses
  const teamSet = useMemo(() => new Set(teamAddresses ?? []), [teamAddresses])
  const replyTo = state?.sender.replyTo ?? ''
  const contacts = useMemo(() => data.contacts ?? [], [data.contacts])
  const today = firmToday()

  const rows = useMemo<PickerRow[]>(() => {
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    const latest = new Map<string, LetterSendRecord>()
    const lastSentRow = new Map<string, LetterSendRecord>()
    // `sends` is this letter's log, newest first: the first row seen per client is its newest.
    for (const send of sends) {
      if (!latest.has(send.clientId)) latest.set(send.clientId, send)
      if (send.status === 'sent' && !lastSentRow.has(send.clientId)) lastSentRow.set(send.clientId, send)
    }
    return clients.map((client): PickerRow => {
      const { addressee, refusal } = invoiceEmailAddressee(client, clients)
      const resolved = refusal ? { to: [], details: [] } : resolveInvoiceRecipients({ client: addressee, contacts })
      // The same filter Send applies, so the list shows the addresses a letter would use.
      const usable = withoutTeamAddresses(resolved.details, teamSet, replyTo)
      const to = usable.map((detail) => detail.email)
      const teamHidden = resolved.details.length - usable.length
      const linked = (client.contactIds ?? [])
        .map((id) => byId.get(id))
        .find((contact) => contact && !contact.archivedAt && contact.name?.trim())
      const master = client.billToClientId ? clients.find((entry) => entry.id === client.billToClientId) : null
      const stage = client.lifecycleStage ?? 'active'

      const pills: string[] = []
      if (client.invoiceNoEmail) pills.push('Invoices never emailed')
      if (client.platformInvoicingOptOut) pills.push('Billed outside the app')
      if (stage === 'inactive') pills.push('Inactive')
      if (stage === 'proposal') pills.push('Proposal stage')
      if (master) pills.push(`Billed through ${master.name}`)
      if (refusal) pills.push('No receiving company set')

      let blocked: string | null = null
      if (refusal) blocked = refusal.message
      else if (to.length === 0) blocked = teamHidden > 0 ? 'Only a team address on file' : 'No email on file'

      const sent = lastSentRow.get(client.id)
      const newest = latest.get(client.id)
      let lastSent = '-'
      if (sent) {
        lastSent = `${dayLabel(sent.firmDay)}${sent.delivery ? ` - ${sent.delivery}` : ''}`
      } else if (newest?.status === 'failed') {
        lastSent = `Failed: ${newest.error ?? 'not sent'}`
      } else if (newest?.status === 'sending') {
        const startedAt = Date.parse(newest.createdAt ?? '')
        lastSent =
          // The same two minutes the server uses to tell a send still running from one that died.
          Number.isFinite(startedAt) && nowMs - startedAt >= LETTER_IN_FLIGHT_MS
            ? 'Did not finish - check before sending again'
            : 'Sending...'
      }

      return {
        client,
        contactName: linked?.name?.trim() || client.contact || '',
        to,
        details: usable,
        teamHidden,
        blocked,
        pills,
        lastSent,
      }
    })
  }, [clients, contacts, sends, nowMs, teamSet, replyTo])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows
      .filter((row) => includeInactive || SHOWN_BY_DEFAULT.has(row.client.lifecycleStage ?? 'active'))
      .filter(
        (row) =>
          !needle ||
          [row.client.name, row.contactName, ...row.to].some((value) =>
            String(value ?? '').toLowerCase().includes(needle),
          ),
      )
      .slice()
      .sort((a, b) => a.client.name.localeCompare(b.client.name))
  }, [rows, includeInactive, query])

  const selectableIds = useMemo(
    () => new Set(rows.filter((row) => row.blocked === null).map((row) => row.client.id)),
    [rows],
  )
  const chosen = [...selected].filter((id) => selectableIds.has(id))
  // Ticked earlier, then a search or a list filter took the row off the screen: still chosen, still sent.
  const shownIds = new Set(shown.map((row) => row.client.id))
  const hiddenChosen = chosen.filter((id) => !shownIds.has(id))
  const hiddenNote = hiddenChosen.length > 0 ? ` (${hiddenChosen.length} hidden)` : ''

  // A billing master's letter covers its sub-companies (their invoices go to the master's mailbox):
  // while the master is chosen, its subs cannot be, and ticking the master unticks them.
  const chosenSet = new Set(chosen)
  const coveredBy = (client: Client) =>
    client.billToClientId && chosenSet.has(client.billToClientId)
      ? (clients.find((entry) => entry.id === client.billToClientId) ?? null)
      : null
  /** Drops from `ids` each sub-company whose master is ticked and pickable (never `keep`); how many of them were out of sight. */
  const dropCovered = (ids: Set<string>, keep: string | null) => {
    let hidden = 0
    for (const client of clients) {
      const master = client.billToClientId
      if (!master || client.id === keep || !ids.has(client.id)) continue
      if (ids.has(master) && selectableIds.has(master)) {
        ids.delete(client.id)
        if (!shownIds.has(client.id)) hidden += 1
      }
    }
    return hidden
  }
  const droppedNote = (hidden: number) =>
    hidden > 0 ? `Unticked ${hidden} covered sub-compan${hidden === 1 ? 'y' : 'ies'}` : ''

  /** One tick or untick on `current`: the new set and the note to show (pure, so it can run inside a state update). */
  const pick = (current: Set<string>, id: string): { next: Set<string>; note: string } => {
    const next = new Set(current)
    if (next.has(id)) {
      next.delete(id)
      return { next, note: '' }
    }
    // Backstop: a sub whose master is ticked is refused, not ticked and then dropped (its box is
    // disabled, so this only matters if a click gets through anyway).
    const master = clients.find((client) => client.id === id)?.billToClientId
    const masterClient = master && next.has(master) && selectableIds.has(master) ? clients.find((client) => client.id === master) : null
    if (masterClient) return { next, note: `Covered by ${masterClient.name}'s letter` }
    next.add(id)
    return { next, note: droppedNote(dropCovered(next, id)) }
  }

  const toggle = (id: string) => {
    setSelected((current) => pick(current, id).next)
    setCoveredNote(pick(selected, id).note)
  }

  const selectAllShown = (current: Set<string>) => {
    const next = new Set(current)
    for (const row of shown) if (row.blocked === null) next.add(row.client.id)
    return { next, note: droppedNote(dropCovered(next, null)) }
  }

  /* ---- sending ------------------------------------------------------------ */

  const sendBatch = async (ids: string[], { resend }: { resend: boolean }) => {
    if (!saved || !state || !letterId || ids.length === 0) return
    const sendingId = letterId
    setSending(true)
    setSendError('')
    setResults((currentResults) => currentResults.filter((result) => !ids.includes(result.clientId)))
    let done = 0
    try {
      for (let at = 0; at < ids.length; at += SEND_CHUNK) {
        const chunk = ids.slice(at, at + SEND_CHUNK)
        setProgress(`Sending ${Math.min(done + 1, ids.length)} to ${Math.min(done + chunk.length, ids.length)} of ${ids.length}...`)
        // Her picker choices for the clients in this request; the rest go to everyone on file.
        const chosenRecipients = Object.fromEntries(
          chunk.filter((id) => recipientChoices[id]).map((id) => [id, recipientChoices[id]]),
        )
        const answer = await sendLettersRequest(sendingId, {
          clientIds: chunk,
          templateHash: state.hash,
          ...(Object.keys(chosenRecipients).length > 0 ? { recipients: chosenRecipients } : {}),
          ...(resend ? { resendToday: true } : {}),
          // Split into requests of ten: tell the server the whole send, so a master and its
          // sub in different requests are still seen together.
          ...(ids.length > SEND_CHUNK ? { batch: ids } : {}),
        })
        done += chunk.length
        // A choice is for its send: once that client's letter went, the next send starts from
        // everyone on file again. A client that failed or was skipped keeps hers, so "Send
        // again to the N that failed" and Send again post the same narrowed list.
        const wentOut = new Set(answer.results.filter((result) => result.status === 'sent').map((result) => result.clientId))
        if (wentOut.size > 0) {
          setRecipientChoices((current) =>
            Object.fromEntries(Object.entries(current).filter(([clientId]) => !wentOut.has(clientId))),
          )
        }
        // A client skipped because an address she ticked is no longer on file: its choice
        // keeps the ticks still on file (and her added ones), and the row says to pick again.
        const stale = new Set(
          answer.results.filter((result) => result.code === 'recipients_changed').map((result) => result.clientId),
        )
        if (stale.size > 0) {
          setRecipientChoices((current) => {
            const next = { ...current }
            for (const clientId of stale) {
              const choice = next[clientId]
              if (!choice) continue
              const onFile = new Set(
                (rows.find((row) => row.client.id === clientId)?.to ?? []).map((email) => email.toLowerCase()),
              )
              next[clientId] = { to: choice.to.filter((email) => onFile.has(email.toLowerCase())), extra: choice.extra }
            }
            return next
          })
        }
        const answered = answer.results.map((result) =>
          stale.has(result.clientId) ? { ...result, message: STALE_RECIPIENT_SENTENCE } : result,
        )
        setResults((currentResults) =>
          reconcileCoveredResults([
            ...currentResults.filter((result) => !chunk.includes(result.clientId)),
            ...answered,
          ]),
        )
        await refreshSends()
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'letter_changed') {
        // Someone saved a different text: show it, and stop before sending more.
        try {
          adopt(await fetchLetterTemplate(sendingId), { overwriteText: !dirtyRef.current })
        } catch {
          // The sentence below still tells her to reload.
        }
      }
      // A request that failed leaves the masters still waiting in it without a result: a sub that
      // was skipped for their letter must not read "covered" when that letter never went.
      setResults((currentResults) => reconcileCoveredResults(currentResults, { missingMasterDidNotGo: true }))
      if (err instanceof ApiError && err.code === 'letter_not_found') void refreshList()
      setSendError(err instanceof ApiError ? err.message : 'Could not send the letters.')
    } finally {
      setSending(false)
      setProgress('')
      void refreshList()
    }
  }

  const sendSelected = async () => {
    if (chosen.length === 0) return
    const replyAddress = state?.sender.replyTo || 'the reply address'
    const count = chosen.length
    const hiddenNames = hiddenChosen.map((id) => clients.find((client) => client.id === id)?.name ?? id)
    const ok = window.confirm(
      `Send "${letterName}" to ${count} client${count === 1 ? '' : 's'}${hiddenNote}? Each gets your email with the letter attached as a PDF. Replies go to ${replyAddress}.` +
        (hiddenNames.length > 0 ? ` Also sending to (not in the list right now): ${hiddenNames.join(', ')}.` : '') +
        // Every client's final list (featreq-34627da1): her choice, or everyone on file.
        ` Recipients - ${chosen.map((id) => `${nameOf(id, null)}: ${finalRecipients(id)}`).join('; ')}.`,
    )
    if (!ok) return
    // A fresh Send starts a fresh list; the retry buttons below merge into it instead.
    setResults([])
    await sendBatch(chosen, { resend: false })
  }

  /** Who one client's letter goes to now: her picker choice, or everyone Send may use. */
  const finalRecipients = (id: string) => {
    const choice = recipientChoices[id]
    if (choice) return recipientListLabel(choice.to, choice.extra)
    return rows.find((row) => row.client.id === id)?.to.join(', ') ?? ''
  }

  const nameOf = (id: string, fallback: string | null) =>
    clients.find((client) => client.id === id)?.name ?? fallback ?? 'This client'

  const failedIds = results.filter((result) => result.status === 'failed').map((result) => result.clientId)

  const sendAnyway = async (id: string, why: 'sent' | 'unfinished' = 'sent') => {
    const name = nameOf(id, null)
    const ok = window.confirm(
      why === 'unfinished'
        ? `Send "${letterName}" to ${name} again? An earlier send to them never finished, so check that it did not go out first. It goes to ${finalRecipients(id)}.`
        : `Send "${letterName}" to ${name} again? It was already sent today. It goes to ${finalRecipients(id)}.`,
    )
    if (!ok) return
    await sendBatch([id], { resend: true })
  }

  const sentToday = (id: string) =>
    sends.some(
      (send) =>
        send.clientId === id &&
        send.status === 'sent' &&
        send.firmDay === today &&
        send.templateHash === state?.hash,
    )

  if (!ownerMode) return null

  const editorLocked = !saved
  const blockedReason = dirty ? 'Save the letter to preview or send it.' : ''
  const previewClient = previewId ? clients.find((client) => client.id === previewId) : null
  const choosingRow = choosingFor ? (rows.find((row) => row.client.id === choosingFor && row.to.length > 0) ?? null) : null
  const fieldHint = (field: Field) => {
    if (field === 'subject') return ''
    return field === 'emailBody'
      ? 'This is the email. The letter rides along as a PDF.'
      : "Blank lines start a new paragraph. The firm letterhead, the date and the client's address are added above it."
  }
  const fieldWord = (field: Field) => (field === 'subject' ? 'subject' : field === 'emailBody' ? 'email' : 'letter')
  // SignWell field tags typed into the letter (task 17): a quiet count, never a warning.
  const esignFields = esignFieldCount(letterBody)

  // The chips are the placeholders the Letters GET lists (the 'both' keys); an
  // engagement-only key is never offered here, even if one were listed.
  const chips = (field: Field) => (
    <PlaceholderChips
      placeholders={(state?.placeholders ?? []).filter((placeholder) => placeholder.scope !== 'engagement')}
      fieldWord={fieldWord(field)}
      onInsert={(key) => insertToken(field, key)}
    />
  )

  const formatBar = (field: BodyField) => (
    <BoldBar fieldWord={fieldWord(field)} disabled={editorLocked} onBold={() => applyBold(field)} />
  )

  const deleteBlocked =
    current && current.sendCount > 0
      ? `"${current.name}" has been sent, so it cannot be deleted - its send history points at it. Rename it instead if it is no longer used.`
      : ''

  return (
    <section className="content-grid" id="letters">
      <div className="panel letters-editor">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Letters</h2>
            <p className="section-subtitle">
              Keep your letters here, each written once with placeholders, then send the one you choose to the clients
              you choose.
            </p>
          </div>
        </div>

        <h3>Your letters</h3>
        {letters && letters.length === 0 ? (
          <p className="empty-state">No letters yet. Add one with New letter.</p>
        ) : null}
        {letters && letters.length > 0 ? (
          <div className="letters-list" role="group" aria-label="Saved letters">
            {letters.map((letter) => (
              <button
                key={letter.id}
                type="button"
                className="letters-list-item"
                aria-pressed={letter.id === letterId}
                title={letter.subject || undefined}
                disabled={sending}
                onClick={() => choose(letter.id)}
              >
                {letter.name}
              </button>
            ))}
          </div>
        ) : null}

        {naming ? (
          <form
            className="letters-name-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitName()
            }}
          >
            <label className="field">
              <span>{naming === 'new' ? 'Name of the new letter' : 'New name'}</span>
              <input
                className="input"
                type="text"
                maxLength={NAME_MAX}
                autoFocus
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
              />
            </label>
            <button type="submit" className="primary-action" disabled={nameBusy || !nameDraft.trim()}>
              {naming === 'new' ? 'Add letter' : 'Save name'}
            </button>
            <button type="button" className="ghost-action" disabled={nameBusy} onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="button-row">
            <button type="button" className="secondary-action" disabled={sending} onClick={() => startNaming('new')}>
              New letter
            </button>
            <button
              type="button"
              className="ghost-action"
              disabled={!current || sending}
              onClick={() => startNaming('rename')}
            >
              Rename
            </button>
            <button
              type="button"
              className="ghost-action"
              disabled={!current || sending || current.sendCount > 0}
              title={deleteBlocked || undefined}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </div>
        )}
        {deleteBlocked && !naming ? <p className="muted-text">{deleteBlocked}</p> : null}
        {listError ? (
          <p className="form-error" role="alert">
            {listError}
          </p>
        ) : null}

        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : null}

        {letterId ? (
          <>
            <h3>{letterName || 'The letter'}</h3>
            <label className="field">
              <span>Subject</span>
              <input
                ref={subjectRef}
                className="input"
                type="text"
                maxLength={200}
                disabled={editorLocked}
                value={subject}
                onFocus={() => {
                  lastFocusedRef.current = null
                }}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            {chips('subject')}

            <div className="field">
              <label htmlFor="letters-email-body">
                <span>Email body</span>
              </label>
              {formatBar('emailBody')}
              <textarea
                id="letters-email-body"
                ref={emailBodyRef}
                className="input"
                rows={8}
                maxLength={20000}
                disabled={editorLocked}
                value={emailBody}
                onFocus={() => {
                  lastFocusedRef.current = 'emailBody'
                }}
                onChange={(event) => setEmailBody(event.target.value)}
                onKeyDown={(event) => boldShortcut(event, 'emailBody')}
              />
            </div>
            <p className="muted-text">{fieldHint('emailBody')}</p>
            {chips('emailBody')}

            <div className="field">
              <label htmlFor="letters-letter-body">
                <span>Letter body</span>
              </label>
              {formatBar('letterBody')}
              <textarea
                id="letters-letter-body"
                ref={letterBodyRef}
                className="input"
                rows={18}
                maxLength={20000}
                disabled={editorLocked}
                value={letterBody}
                onFocus={() => {
                  lastFocusedRef.current = 'letterBody'
                }}
                onChange={(event) => setLetterBody(event.target.value)}
                onKeyDown={(event) => boldShortcut(event, 'letterBody')}
              />
            </div>
            <p className="muted-text">{fieldHint('letterBody')}</p>
            <p className="muted-text">
              For bold, select words and press B (or Ctrl+B): they are wrapped in **double asterisks** and come out
              bold in the email and the PDF. The subject is never bold.
            </p>
            {chips('letterBody')}
            {esignFields ? <p className="muted-text">{esignFields}</p> : null}

            {warnings.unknown.length > 0 ? (
              <p className="form-error" role="status">
                {unknownPlaceholderSentence(warnings.unknown)}
              </p>
            ) : null}
            {warnings.retired.length > 0 ? (
              <p className="form-error" role="status">
                {`${retiredSentence(warnings.retired)}.`}
              </p>
            ) : null}
            {saveError ? (
              <p className="form-error" role="alert">
                {saveError}
              </p>
            ) : null}

            <div className="button-row">
              <button
                type="button"
                className="primary-action"
                disabled={editorLocked || !dirty || saveState === 'saving'}
                onClick={() => void save()}
              >
                Save
              </button>
              <SaveBadge state={saveState} />
              {saved?.updatedAt ? (
                <span className="muted-text">
                  Last saved {new Date(saved.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {saved.updatedByName ? ` by ${saved.updatedByName}` : ''}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
        {state ? (
          <p className="muted-text">
            Letters come from {state.sender.from || 'the invoice address (not set)'} and replies go to{' '}
            {state.sender.replyTo || 'no one (no reply address is set)'}. Nothing is copied to anyone else.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="section-heading">
          <div>
            <h3>{letterName ? `Send "${letterName}" to` : 'Send to'}</h3>
            <p className="section-subtitle">
              Each client gets your email with the letter attached as a PDF, filled in for them. Last sent is for this
              letter.
            </p>
          </div>
        </div>

        <div className="button-row">
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search clients"
            resultCount={shown.length}
            total={rows.length}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            <span>Include inactive and proposal-stage clients</span>
          </label>
          <button
            type="button"
            className="ghost-action"
            onClick={() => {
              setSelected((current) => selectAllShown(current).next)
              setCoveredNote(selectAllShown(selected).note)
            }}
          >
            Select all shown
          </button>
          <button
            type="button"
            className="ghost-action"
            onClick={() => {
              setSelected(new Set())
              setCoveredNote('')
            }}
          >
            Clear
          </button>
          <span className="muted-text">{`${chosen.length} selected${hiddenNote}`}</span>
          {coveredNote ? (
            <span className="muted-text" role="status">
              {coveredNote}
            </span>
          ) : null}
          {hiddenChosen.length > 0 ? (
            <button
              type="button"
              className="ghost-action"
              onClick={() =>
                setSelected((currentSet) => {
                  const next = new Set(currentSet)
                  for (const id of hiddenChosen) next.delete(id)
                  return next
                })
              }
            >
              Untick hidden
            </button>
          ) : null}
        </div>

        <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>Client</th>
                <th>Email</th>
                <th>Flags</th>
                <th>Last sent</th>
                <th aria-label="Preview" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <p className="empty-state">No clients match.</p>
                  </td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.client.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.client.name}`}
                      checked={row.blocked === null && selected.has(row.client.id)}
                      disabled={row.blocked !== null || sending || coveredBy(row.client) !== null}
                      onChange={() => toggle(row.client.id)}
                    />
                  </td>
                  <td>
                    <strong>{row.client.name}</strong>
                    {row.contactName ? <div className="muted-text">{row.contactName}</div> : null}
                    {coveredBy(row.client) ? (
                      <div className="muted-text">{`Covered by ${coveredBy(row.client)?.name}'s letter`}</div>
                    ) : null}
                  </td>
                  <td>
                    {row.to.length > 0 ? (
                      recipientChoices[row.client.id] ? (
                        recipientListLabel(recipientChoices[row.client.id].to, recipientChoices[row.client.id].extra)
                      ) : (
                        row.to.join(', ')
                      )
                    ) : (
                      <span className="muted-text">{row.teamHidden > 0 ? 'Only a team address on file' : 'No email on file'}</span>
                    )}
                    {row.to.length > 0 ? (
                      <div>
                        <button
                          type="button"
                          className="ghost-action"
                          aria-label={`Change who ${row.client.name} gets it`}
                          disabled={sending}
                          onClick={() => setChoosingFor(row.client.id)}
                        >
                          Change
                        </button>
                        {recipientChoices[row.client.id] ? <span className="muted-text">Chosen for this send</span> : null}
                      </div>
                    ) : null}
                    {row.teamHidden > 0 ? (
                      <div className="muted-text">{`${row.teamHidden} team address${row.teamHidden === 1 ? '' : 'es'} hidden`}</div>
                    ) : null}
                  </td>
                  <td>
                    <div className="button-row">
                      {row.pills.map((pill) => (
                        <span key={pill} className="status-pill">
                          {pill}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {row.lastSent}
                    {sentToday(row.client.id) ? (
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending || dirty}
                        onClick={() => void sendAnyway(row.client.id)}
                      >
                        Send again
                      </button>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost-action"
                      disabled={dirty || !saved}
                      title={blockedReason || undefined}
                      onClick={() => setPreviewId(row.client.id)}
                    >
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {blockedReason ? <p className="muted-text">{blockedReason}</p> : null}
        {sendError ? (
          <p className="form-error" role="alert">
            {sendError}
          </p>
        ) : null}

        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={sending || dirty || chosen.length === 0 || !saved}
            onClick={() => void sendSelected()}
          >
            {`Send "${letterName}" to ${chosen.length} client${chosen.length === 1 ? '' : 's'}${hiddenNote}`}
          </button>
          {progress ? <span className="muted-text">{progress}</span> : null}
        </div>

        {results.length > 0 ? (
          <div aria-label="Send results">
            <h3>Results</h3>
            <p className="muted-text">
              {results.filter((result) => result.status === 'sent').length} sent,{' '}
              {results.filter((result) => result.status === 'skipped').length} skipped,{' '}
              {failedIds.length} failed.
            </p>
            <ul className="letters-results">
              {results.map((result) => (
                <li key={result.clientId}>
                  <strong>{nameOf(result.clientId, result.clientName)}</strong>:{' '}
                  {result.status === 'sent' ? (
                    <span>
                      Sent to {(result.to ?? []).join(', ')}
                      {result.engagementId ? (
                        <>
                          {' '}
                          <Link className="ghost-action" to={`/engagements/${result.engagementId}`}>
                            View in Engagements
                          </Link>
                        </>
                      ) : null}
                    </span>
                  ) : result.code === 'already_sent' ? (
                    <span>
                      Already sent today.{' '}
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending || dirty}
                        onClick={() => void sendAnyway(result.clientId)}
                      >
                        Send again anyway
                      </button>
                    </span>
                  ) : result.code === 'unfinished' ? (
                    <span>
                      Not sent: {result.message}{' '}
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending || dirty}
                        onClick={() => void sendAnyway(result.clientId, 'unfinished')}
                      >
                        Send again anyway
                      </button>
                    </span>
                  ) : (
                    <span>
                      {result.status === 'failed' ? 'Failed: ' : 'Not sent: '}
                      {result.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {failedIds.length > 0 ? (
              <button
                type="button"
                className="secondary-action"
                disabled={sending || dirty}
                onClick={() => void sendBatch(failedIds, { resend: false })}
              >
                {`Send again to the ${failedIds.length} that failed`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {previewId && previewClient && letterId ? (
        <LetterPreviewModal
          letterId={letterId}
          clientId={previewId}
          clientName={previewClient.name}
          batchIds={previewClient.billToClientId && chosenSet.has(previewClient.billToClientId) ? [previewClient.billToClientId] : []}
          onClose={() => setPreviewId(null)}
        />
      ) : null}

      {/* The shared recipient picker for one client's letter (featreq-34627da1): the
          addresses Send may use (team addresses never listed), today's list ticked.
          It sends nothing itself - the choice rides on the next Send. */}
      {choosingRow ? (
        <RecipientPicker
          label={`"${letterName}" for ${choosingRow.client.name}`}
          details={choosingRow.details}
          initial={
            recipientChoices[choosingRow.client.id]
              ? {
                  chosen: [
                    ...recipientChoices[choosingRow.client.id].to,
                    ...recipientChoices[choosingRow.client.id].extra,
                  ],
                  extras: recipientChoices[choosingRow.client.id].extra,
                }
              : null
          }
          actionLabel={(total) => `Use ${total} address${total === 1 ? '' : 'es'}`}
          onSend={(to, extra) => {
            setRecipientChoices((current) => ({ ...current, [choosingRow.client.id]: { to, extra } }))
            setChoosingFor(null)
          }}
          onCancel={() => setChoosingFor(null)}
        />
      ) : null}
    </section>
  )
}
