import { useMemo, useState, type DragEvent, type FormEvent } from 'react'
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardList,
  GripVertical,
  HelpCircle,
  Lightbulb,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useAppContext } from '../AppContext'
import { confirmRejectFeedbackRequest } from '../lib/api'
import {
  formatBacklogForClaude,
  formatRequestForClaude,
  PRIORITY_LABELS,
  sortFeatureRequests,
} from '../lib/updatesCopy'
import type {
  FeatureRequest,
  FeatureRequestPriority,
  FeatureRequestStatus,
  FeatureRequestType,
} from '../lib/types'

const PRIORITY_OPTIONS: Array<{ value: FeatureRequestPriority; label: string }> = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

const TYPE_OPTIONS: Array<{ value: FeatureRequestType; label: string }> = [
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
]

const STATUS_OPTIONS: Array<{ value: FeatureRequestStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'planned', label: 'Planned' },
  { value: 'planned_not_eom', label: 'Planned (not near EOM)' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'needs_input', label: 'Needs answer' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'done', label: 'Done' },
  { value: 'wont_do', label: "Won't do" },
]

/** Closed statuses — visually de-emphasized and hidable via the filter. */
const CLOSED_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set<FeatureRequestStatus>([
  'done',
  'wont_do',
])

/**
 * Section display order: Shipped pinned to the TOP (so the owner lands on
 * just-shipped work awaiting sign-off), then the rest in workflow order.
 */
const SECTION_OPTIONS: typeof STATUS_OPTIONS = [
  // 'needs_input' is rendered by its own pinned "Needs your answer" panel
  // above the sections, so it's excluded from the generic loop.
  ...STATUS_OPTIONS.filter((option) => option.value === 'shipped'),
  ...STATUS_OPTIONS.filter(
    (option) => option.value !== 'shipped' && option.value !== 'needs_input',
  ),
]

/** "Jul 24 · 9:12 PM" for the shipped-at stamp next to a Shipped item's title. */
function formatShippedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

/** Format an approval timestamp for the "Approved by … · <date>" line. */
function formatApprovedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function TypeBadge({ type }: { type: FeatureRequestType }) {
  const Icon = type === 'bug' ? Bug : type === 'improvement' ? Lightbulb : Sparkles
  const label = TYPE_OPTIONS.find((o) => o.value === type)?.label ?? 'Feature'
  return (
    <span className={`updates-type-badge updates-type-${type}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  )
}

function PriorityBadge({ priority }: { priority: FeatureRequestPriority }) {
  return (
    <span className={`updates-priority-badge updates-priority-${priority}`}>
      {PRIORITY_LABELS[priority]}
    </span>
  )
}

/**
 * Owner-only "Updates" page — a tracker for pending feature/bug/improvement
 * items. Set a priority level (Urgent/High/Medium/Low — items group by level
 * first), drag to rank within a level, move through statuses, have the AI
 * refine rough notes into a dev-ready spec, and copy a paste-ready block for
 * Claude Code.
 */
export function UpdatesPage() {
  const {
    ownerMode,
    data,
    featureRequests,
    addFeatureRequest,
    updateFeatureRequest,
    reorderFeatureRequests,
    removeFeatureRequest,
    refineFeatureRequest,
  } = useAppContext()

  // Resolve an approver's user id to a readable name for the "Approved by" line.
  const employeeName = (userId: string | null | undefined): string | null => {
    if (!userId) return null
    return data.employees.find((emp) => emp.id === userId)?.name ?? null
  }

  // Add-item form.
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newType, setNewType] = useState<FeatureRequestType>('feature')
  const [newPriority, setNewPriority] = useState<FeatureRequestPriority>('medium')
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [hideDone, setHideDone] = useState(false)
  // Which status sections are collapsed. By default everything EXCEPT Shipped is
  // collapsed, so the owner lands on the just-shipped work awaiting her sign-off
  // and can expand the rest as needed.
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<FeatureRequestStatus>>(
    () =>
      new Set<FeatureRequestStatus>(
        STATUS_OPTIONS.map((option) => option.value).filter((value) => value !== 'shipped'),
      ),
  )

  // Transient "Copied ✓" flash, keyed by a copy-source id ('all' or item id).
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Drag-to-reorder.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // Per-item refine state: the suggestion panel + busy/error flags.
  const [refineState, setRefineState] = useState<
    Record<string, { busy: boolean; error: string | null; suggestion: { title: string; description: string } | null }>
  >({})

  // Per-item "Not approved" reject panel: the open draft reason text, keyed by
  // item id. An entry's presence means the reason textarea is open for that
  // shipped item.
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({})
  // AI read-back of the rejection reason (per item): busy while the model runs,
  // then either the confirmation to approve or an error with a plain fallback.
  const [rejectConfirm, setRejectConfirm] = useState<
    Record<
      string,
      {
        busy: boolean
        error: string | null
        confirmation: string | null
        forDeveloper: string | null
      }
    >
  >({})
  // Clarification answers being typed in the pinned "Needs your answer" panel,
  // keyed by item id (local drafts; saved only on the Answer button).
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({})
  // Title + description editing draft (local, so typing never saves per-keystroke).
  const [editDraft, setEditDraft] = useState<{
    id: string
    title: string
    description: string
  } | null>(null)

  const sorted = useMemo(() => sortFeatureRequests(featureRequests), [featureRequests])
  // One collapsible section per status (New → Planned → In Progress → Shipped →
  // Done → Won't do). Items keep their priority order inside a section and are
  // drag-reorderable within it.
  const byStatus = useMemo(() => {
    const map = new Map<FeatureRequestStatus, FeatureRequest[]>()
    for (const option of STATUS_OPTIONS) map.set(option.value, [])
    for (const item of sorted) map.get(item.status)?.push(item)
    return map
  }, [sorted])
  const statusOfId = (id: string) => sorted.find((item) => item.id === id)?.status
  const openCount = sorted.filter((i) => !CLOSED_STATUSES.has(i.status)).length

  if (!ownerMode) return null

  const flashCopied = (key: string) => {
    setCopiedKey(key)
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current))
    }, 1600)
  }

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      flashCopied(key)
    } catch {
      /* clipboard blocked (e.g. insecure context) — silently no-op */
    }
  }

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault()
    const title = newTitle.trim()
    const description = newDescription.trim()
    if (!title || !description) {
      setFormError('A title and description are required.')
      return
    }
    setAdding(true)
    setFormError(null)
    try {
      await addFeatureRequest({ title, description, type: newType, priority: newPriority })
      setNewTitle('')
      setNewDescription('')
      setNewType('feature')
      setNewPriority('medium')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not add that update.')
    } finally {
      setAdding(false)
    }
  }

  const handleDragStart = (event: DragEvent<HTMLElement>, id: string) => {
    setDraggingId(id)
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault()
    // Re-ranking only makes sense within the same status section.
    if (draggingId && draggingId !== id && statusOfId(draggingId) === statusOfId(id)) {
      setDropTargetId(id)
    }
  }

  const handleDragLeave = () => setDropTargetId(null)

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!draggingId || draggingId === targetId || statusOfId(draggingId) !== statusOfId(targetId)) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    // Reorder within the full sorted list. The sort groups by priority level
    // first, so dragging effectively re-ranks within a level; crossing a level
    // boundary just re-groups under the item's own level on the next sort.
    const orderedIds = sorted.map((i) => i.id)
    const fromIdx = orderedIds.indexOf(draggingId)
    const toIdx = orderedIds.indexOf(targetId)
    setDraggingId(null)
    setDropTargetId(null)
    if (fromIdx === -1 || toIdx === -1) return
    orderedIds.splice(fromIdx, 1)
    orderedIds.splice(toIdx, 0, draggingId)
    void reorderFeatureRequests(orderedIds)
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropTargetId(null)
  }

  const toggleStatusSection = (status: FeatureRequestStatus) =>
    setCollapsedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  const setAllCollapsed = (collapsed: boolean) =>
    setCollapsedStatuses(collapsed ? new Set(STATUS_OPTIONS.map((o) => o.value)) : new Set())

  const handleRefine = async (item: FeatureRequest) => {
    setRefineState((prev) => ({
      ...prev,
      [item.id]: { busy: true, error: null, suggestion: prev[item.id]?.suggestion ?? null },
    }))
    try {
      const suggestion = await refineFeatureRequest(item.id)
      setRefineState((prev) => ({
        ...prev,
        [item.id]: { busy: false, error: null, suggestion },
      }))
    } catch (error) {
      setRefineState((prev) => ({
        ...prev,
        [item.id]: {
          busy: false,
          error: error instanceof Error ? error.message : 'The AI could not refine this.',
          suggestion: null,
        },
      }))
    }
  }

  const acceptRefine = async (item: FeatureRequest) => {
    const suggestion = refineState[item.id]?.suggestion
    if (!suggestion) return
    await updateFeatureRequest(item.id, {
      title: suggestion.title || item.title,
      description: suggestion.description || item.description,
    })
    setRefineState((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
  }

  const discardRefine = (id: string) => {
    setRefineState((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // "Not approved" flow: open/close the reason textarea and send the item back
  // to the developer with the rejection note.
  const openReject = (id: string) =>
    setRejectDrafts((prev) => (id in prev ? prev : { ...prev, [id]: '' }))

  const setRejectText = (id: string, text: string) =>
    setRejectDrafts((prev) => ({ ...prev, [id]: text }))

  const cancelReject = (id: string) => {
    setRejectDrafts((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRejectConfirm((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // AI read-back step: before her reason is filed, the AI restates it for her
  // confirmation (and produces the dev-ready version filed alongside). Sending
  // back returns the item to PLANNED — same as answering a clarification — so
  // the dev queue picks it up with the confirmed feedback attached.
  const requestRejectConfirm = async (item: FeatureRequest) => {
    const note = (rejectDrafts[item.id] ?? '').trim()
    if (!note) return
    setRejectConfirm((prev) => ({
      ...prev,
      [item.id]: { busy: true, error: null, confirmation: null, forDeveloper: null },
    }))
    try {
      const result = await confirmRejectFeedbackRequest(item.id, note)
      setRejectConfirm((prev) => ({
        ...prev,
        [item.id]: {
          busy: false,
          error: null,
          confirmation: result.confirmation,
          forDeveloper: result.forDeveloper,
        },
      }))
    } catch (error) {
      setRejectConfirm((prev) => ({
        ...prev,
        [item.id]: {
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : 'The AI could not review this feedback right now.',
          confirmation: null,
          forDeveloper: null,
        },
      }))
    }
  }

  const fileReject = async (item: FeatureRequest, forDeveloper: string | null) => {
    const note = (rejectDrafts[item.id] ?? '').trim()
    if (!note) return
    const reviewNote = forDeveloper ? `${note}\n\n[Confirmed rework spec] ${forDeveloper}` : note
    await updateFeatureRequest(item.id, { status: 'planned', reviewNote })
    cancelReject(item.id)
  }

  // Title + description editing: the draft (state above) is only persisted when
  // the user clicks Save — typing never saves per-keystroke (which used to
  // re-sort the list and steal focus).
  const startEdit = (item: FeatureRequest) =>
    setEditDraft({ id: item.id, title: item.title, description: item.description })

  const saveEdit = async (item: FeatureRequest) => {
    if (!editDraft || editDraft.id !== item.id) return
    const title = editDraft.title.trim()
    if (!title) return
    await updateFeatureRequest(item.id, { title, description: editDraft.description.trim() })
    setEditDraft(null)
  }

  const handleDelete = async (item: FeatureRequest) => {
    if (!window.confirm(`Delete “${item.title}”? This can't be undone.`)) return
    await removeFeatureRequest(item.id)
  }

  const renderCard = (item: FeatureRequest) => {
    const closed = CLOSED_STATUSES.has(item.status)
    const refine = refineState[item.id]
    const rejectOpen = item.id in rejectDrafts
    const isEditing = editDraft?.id === item.id
    const classes = ['updates-card', `updates-priority-card-${item.priority}`]
    if (closed) classes.push('closed')
    if (item.status === 'in_progress') classes.push('updates-card-in-progress')
    if (draggingId === item.id) classes.push('dragging')
    if (dropTargetId === item.id) classes.push('drop-target')
    const reviewedWhen = formatApprovedAt(item.reviewedAt)
    return (
      <div
        key={item.id}
        className={classes.join(' ')}
        onDragOver={(event) => handleDragOver(event, item.id)}
        onDragLeave={handleDragLeave}
        onDrop={(event) => handleDrop(event, item.id)}
        onDragEnd={handleDragEnd}
      >
        <div className="updates-card-main">
          {/* Only the handle is draggable — making the whole card draggable
              hijacked mousedown on the buttons/inputs inside it (Refine, Save,
              Edit, the textareas), so they wouldn't reliably click/focus. */}
          <span
            className="drag-handle"
            title="Drag to reorder"
            draggable
            onDragStart={(event) => handleDragStart(event, item.id)}
            onDragEnd={handleDragEnd}
          >
            <GripVertical size={14} />
          </span>
          <div className="updates-card-body">
            <div className="updates-card-titlerow">
              {isEditing ? (
                <input
                  className="updates-title-input"
                  type="text"
                  value={editDraft.title}
                  maxLength={120}
                  aria-label="Title"
                  autoFocus
                  onChange={(event) =>
                    setEditDraft((draft) =>
                      draft ? { ...draft, title: event.target.value } : draft,
                    )
                  }
                />
              ) : (
                <button
                  type="button"
                  className="updates-title-static"
                  title="Click to edit the title"
                  onClick={() => startEdit(item)}
                >
                  {item.title}
                </button>
              )}
              {item.status === 'shipped' && formatShippedAt(item.shippedAt) ? (
                // When this change went live — right of the title while the
                // item awaits the owner's review.
                <span
                  className="updates-shipped-at"
                  title="When this was shipped (deployed and live)"
                >
                  Shipped {formatShippedAt(item.shippedAt)}
                </span>
              ) : null}
              <select
                className={`updates-priority-select updates-priority-${item.priority}`}
                value={item.priority}
                aria-label="Priority"
                title="Priority level"
                onChange={(event) =>
                  void updateFeatureRequest(item.id, {
                    priority: event.target.value as FeatureRequestPriority,
                  })
                }
              >
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="updates-card-meta">
              <PriorityBadge priority={item.priority} />
              <TypeBadge type={item.type} />
              <select
                className={`updates-status-select${
                  item.status === 'shipped' ? ' updates-status-shipped' : ''
                }`}
                value={item.status}
                aria-label="Status"
                onChange={(event) =>
                  void updateFeatureRequest(item.id, {
                    status: event.target.value as FeatureRequestStatus,
                  })
                }
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              {item.status === 'shipped' ? (
                <>
                  <button
                    type="button"
                    className="updates-approve-button"
                    title="Mark this shipped update as approved (closes it)"
                    onClick={() => void updateFeatureRequest(item.id, { status: 'done' })}
                  >
                    <Check size={13} aria-hidden="true" /> Mark approved
                  </button>
                  <button
                    type="button"
                    className="updates-reject-button"
                    title="Send this shipped update back to the developer with a reason"
                    onClick={() => openReject(item.id)}
                  >
                    <X size={13} aria-hidden="true" /> Not approved
                  </button>
                </>
              ) : null}

              {item.status === 'done'
                ? (() => {
                    const approver = employeeName(item.approvedBy)
                    const when = formatApprovedAt(item.approvedAt)
                    return (
                      <span className="updates-approved-by">
                        {approver
                          ? `Approved by ${approver}${when ? ` · ${when}` : ''}`
                          : 'Done'}
                      </span>
                    )
                  })()
                : null}
            </div>

            {item.reviewNote ? (
              <p className="updates-review-note">
                Not approved{reviewedWhen ? ` — ${reviewedWhen}` : ''}: {item.reviewNote}
              </p>
            ) : null}

            {item.clarificationAnswer ? (
              // The answered clarification stays on the card as the record of
              // what was decided (question + the owner's answer).
              <p className="updates-clarification-line">
                {item.clarificationQuestion?.trim()
                  ? `Q: ${item.clarificationQuestion} — A: ${item.clarificationAnswer}`
                  : `Owner's answer: ${item.clarificationAnswer}`}
              </p>
            ) : null}

            {rejectOpen ? (
              <div className="updates-reject-panel">
                <p className="updates-reject-kicker">Send back to the developer</p>
                <textarea
                  className="updates-reject-input"
                  value={rejectDrafts[item.id] ?? ''}
                  maxLength={2000}
                  rows={3}
                  aria-label="Rejection reason"
                  placeholder="What still needs fixing? Plain language is fine — you'll get a read-back to confirm."
                  onChange={(event) => {
                    setRejectText(item.id, event.target.value)
                    // Editing the reason invalidates a previous read-back.
                    setRejectConfirm((prev) => {
                      if (!(item.id in prev)) return prev
                      const next = { ...prev }
                      delete next[item.id]
                      return next
                    })
                  }}
                />
                {(() => {
                  const confirm = rejectConfirm[item.id]
                  if (confirm?.confirmation) {
                    return (
                      <div className="updates-reject-confirm">
                        <p className="updates-reject-confirm-text">{confirm.confirmation}</p>
                        <div className="updates-reject-actions">
                          <button
                            type="button"
                            className="primary-action"
                            onClick={() => void fileReject(item, confirm.forDeveloper)}
                          >
                            <Check size={14} aria-hidden="true" /> Yes — send back
                          </button>
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={() =>
                              setRejectConfirm((prev) => {
                                const next = { ...prev }
                                delete next[item.id]
                                return next
                              })
                            }
                          >
                            Not quite — let me reword
                          </button>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <>
                      {confirm?.error ? (
                        <p className="updates-form-error">{confirm.error}</p>
                      ) : null}
                      <div className="updates-reject-actions">
                        <button
                          type="button"
                          className="primary-action"
                          disabled={!(rejectDrafts[item.id] ?? '').trim() || confirm?.busy}
                          onClick={() => void requestRejectConfirm(item)}
                        >
                          <X size={14} aria-hidden="true" />{' '}
                          {confirm?.busy ? 'Reading it back…' : 'Send back'}
                        </button>
                        {confirm?.error ? (
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={() => void fileReject(item, null)}
                          >
                            Send back without the read-back
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={confirm?.busy}
                          onClick={() => cancelReject(item.id)}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )
                })()}
              </div>
            ) : null}

            {isEditing ? (
              <>
                <textarea
                  className="updates-description-input"
                  value={editDraft.description}
                  maxLength={2000}
                  rows={4}
                  aria-label="Description"
                  placeholder="Description…"
                  onChange={(event) =>
                    setEditDraft((draft) =>
                      draft ? { ...draft, description: event.target.value } : draft,
                    )
                  }
                />
                <div className="updates-edit-actions">
                  <button
                    type="button"
                    className="primary-action"
                    disabled={!editDraft.title.trim()}
                    onClick={() => void saveEdit(item)}
                  >
                    <Check size={14} aria-hidden="true" /> Save
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => setEditDraft(null)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="updates-description-static-row">
                {item.description ? (
                  <p className="updates-description-static">{item.description}</p>
                ) : (
                  <p className="updates-description-static muted-text">No description yet.</p>
                )}
                <button
                  type="button"
                  className="updates-edit-button"
                  title="Edit title &amp; description"
                  onClick={() => startEdit(item)}
                >
                  <Pencil size={13} aria-hidden="true" /> Edit
                </button>
              </div>
            )}

            {refine?.suggestion ? (
              <div className="updates-refine-panel">
                <p className="updates-refine-kicker">Suggested rewrite</p>
                <strong>{refine.suggestion.title}</strong>
                <pre className="updates-refine-description">{refine.suggestion.description}</pre>
                <div className="updates-refine-actions">
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => void acceptRefine(item)}
                  >
                    <Check size={14} aria-hidden="true" /> Accept
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => discardRefine(item.id)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
            {refine?.error ? <p className="updates-form-error">{refine.error}</p> : null}

            <div className="updates-card-actions">
              <button
                type="button"
                className="secondary-action"
                disabled={refine?.busy}
                onClick={() => void handleRefine(item)}
              >
                <Sparkles size={14} aria-hidden="true" />{' '}
                {refine?.busy ? 'Refining…' : 'Refine for dev'}
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void copyText(formatRequestForClaude(item), `item-${item.id}`)}
              >
                {copiedKey === `item-${item.id}` ? (
                  <>
                    <Check size={14} aria-hidden="true" /> Copied
                  </>
                ) : (
                  <>
                    <Clipboard size={14} aria-hidden="true" /> Copy for Claude Code
                  </>
                )}
              </button>
              <button
                type="button"
                className="danger-action updates-delete"
                title="Delete"
                onClick={() => void handleDelete(item)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <section className="content-grid" id="updates-page">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Feature &amp; bug tracker</p>
            <h2>Updates</h2>
          </div>
          <div className="updates-header-actions">
            <button
              type="button"
              className="secondary-action"
              disabled={openCount === 0}
              onClick={() => void copyText(formatBacklogForClaude(featureRequests), 'all')}
            >
              {copiedKey === 'all' ? (
                <>
                  <Check size={15} aria-hidden="true" /> Copied
                </>
              ) : (
                <>
                  <ClipboardList size={15} aria-hidden="true" /> Copy all (prioritized)
                </>
              )}
            </button>
          </div>
        </div>

        <form className="updates-add-form" onSubmit={handleAdd}>
          <div className="updates-add-row">
            <input
              type="text"
              placeholder="Title — e.g. Saving notes sometimes loses my edits"
              value={newTitle}
              maxLength={120}
              onChange={(event) => setNewTitle(event.target.value)}
              aria-label="Update title"
            />
            <select
              value={newType}
              onChange={(event) => setNewType(event.target.value as FeatureRequestType)}
              aria-label="Update type"
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={`updates-priority-select updates-priority-${newPriority}`}
              value={newPriority}
              onChange={(event) => setNewPriority(event.target.value as FeatureRequestPriority)}
              aria-label="Priority"
              title="Priority — set it right here so you don't have to find the item afterwards"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            placeholder="Describe what you want or what's broken — plain language is fine. Use “Refine for dev” after adding to clean it up."
            value={newDescription}
            maxLength={2000}
            rows={3}
            onChange={(event) => setNewDescription(event.target.value)}
            aria-label="Update description"
          />
          {formError ? <p className="updates-form-error">{formError}</p> : null}
          <div className="updates-add-actions">
            <button type="submit" className="primary-action" disabled={adding}>
              <Plus size={15} aria-hidden="true" /> {adding ? 'Adding…' : 'Add update'}
            </button>
          </div>
        </form>

        <div className="updates-list-toolbar">
          <span className="muted-text">
            {openCount} open · {sorted.length} total
          </span>
          <div className="updates-toolbar-controls">
            <button type="button" className="link-button" onClick={() => setAllCollapsed(false)}>
              Expand all
            </button>
            <button type="button" className="link-button" onClick={() => setAllCollapsed(true)}>
              Collapse all
            </button>
            <label className="updates-filter-toggle">
              <input
                type="checkbox"
                checked={hideDone}
                onChange={(event) => setHideDone(event.target.checked)}
              />
              Hide Done / Won&apos;t do
            </label>
          </div>
        </div>

        {(byStatus.get('needs_input') ?? []).length > 0 ? (
          <div className="updates-needs-input-panel">
            <div className="updates-needs-input-head">
              <HelpCircle size={16} aria-hidden="true" />
              <strong>Needs your answer</strong>
              <span className="muted-text">
                the developer is blocked on these — answering sends the item back to Planned
              </span>
            </div>
            {(byStatus.get('needs_input') ?? []).map((item) => {
              const draft = answerDrafts[item.id] ?? ''
              const submitAnswer = async () => {
                const answer = draft.trim()
                if (!answer) return
                await updateFeatureRequest(item.id, {
                  clarificationAnswer: answer,
                  status: 'planned',
                })
                setAnswerDrafts((current) => {
                  const next = { ...current }
                  delete next[item.id]
                  return next
                })
              }
              return (
                <div key={item.id} className="updates-needs-input-card">
                  <p className="updates-needs-input-title">{item.title}</p>
                  <p className="updates-needs-input-question">
                    {item.clarificationQuestion?.trim() ||
                      'The developer flagged this as needing your input — see its notes for details.'}
                  </p>
                  <textarea
                    className="updates-needs-input-answer"
                    value={draft}
                    rows={2}
                    maxLength={2000}
                    placeholder="Your answer — one or two sentences is plenty…"
                    aria-label={`Answer for ${item.title}`}
                    onChange={(event) =>
                      setAnswerDrafts((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="updates-needs-input-actions">
                    <button
                      type="button"
                      className="primary-action"
                      disabled={!draft.trim()}
                      onClick={() => void submitAnswer()}
                    >
                      <Check size={14} aria-hidden="true" /> Answer &amp; return to Planned
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <p className="muted-text updates-empty">
            No updates yet. Add one above, or send one from the assistant — they show up here.
          </p>
        ) : (
          SECTION_OPTIONS.map((option) => {
            const items = byStatus.get(option.value) ?? []
            if (items.length === 0) return null
            if (hideDone && CLOSED_STATUSES.has(option.value)) return null
            const isCollapsed = collapsedStatuses.has(option.value)
            return (
              <div className="updates-status-section" key={option.value}>
                <button
                  type="button"
                  className={`updates-status-header updates-status-header--${option.value}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleStatusSection(option.value)}
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <span className="updates-status-name">
                    {option.label}
                    {option.value === 'shipped' ? ' — awaiting approval' : ''}
                  </span>
                  <span className="updates-status-count">{items.length}</span>
                </button>
                {isCollapsed ? null : (
                  <div className="updates-list">{items.map((item) => renderCard(item))}</div>
                )}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
