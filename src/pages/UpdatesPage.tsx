import { useMemo, useState, type DragEvent, type FormEvent } from 'react'
import {
  Bug,
  Check,
  Clipboard,
  ClipboardList,
  GripVertical,
  Lightbulb,
  Plus,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react'
import { useAppContext } from '../AppContext'
import {
  formatBacklogForClaude,
  formatRequestForClaude,
  sortFeatureRequests,
} from '../lib/updatesCopy'
import type {
  FeatureRequest,
  FeatureRequestStatus,
  FeatureRequestType,
} from '../lib/types'

const TYPE_OPTIONS: Array<{ value: FeatureRequestType; label: string }> = [
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
]

const STATUS_OPTIONS: Array<{ value: FeatureRequestStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'wont_do', label: "Won't do" },
]

/** Closed statuses — visually de-emphasized and hidable via the filter. */
const CLOSED_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set<FeatureRequestStatus>([
  'done',
  'wont_do',
])

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

/**
 * Owner-only "Updates" page — a tracker for pending feature/bug/improvement
 * items. Drag to rank priority, flag Urgent (pins to top), move through
 * statuses, have the AI refine rough notes into a dev-ready spec, and copy a
 * paste-ready block for Claude Code.
 */
export function UpdatesPage() {
  const {
    ownerMode,
    featureRequests,
    addFeatureRequest,
    updateFeatureRequest,
    reorderFeatureRequests,
    removeFeatureRequest,
    refineFeatureRequest,
  } = useAppContext()

  // Add-item form.
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newType, setNewType] = useState<FeatureRequestType>('feature')
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [hideDone, setHideDone] = useState(false)

  // Transient "Copied ✓" flash, keyed by a copy-source id ('all' or item id).
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Drag-to-reorder.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // Per-item refine state: the suggestion panel + busy/error flags.
  const [refineState, setRefineState] = useState<
    Record<string, { busy: boolean; error: string | null; suggestion: { title: string; description: string } | null }>
  >({})

  const sorted = useMemo(() => sortFeatureRequests(featureRequests), [featureRequests])
  const visible = hideDone ? sorted.filter((i) => !CLOSED_STATUSES.has(i.status)) : sorted
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
      await addFeatureRequest({ title, description, type: newType })
      setNewTitle('')
      setNewDescription('')
      setNewType('feature')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not add that update.')
    } finally {
      setAdding(false)
    }
  }

  const handleDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id)
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault()
    if (draggingId && draggingId !== id) setDropTargetId(id)
  }

  const handleDragLeave = () => setDropTargetId(null)

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    // Reorder within the full sorted list (urgent items stay pinned server-side
    // by the urgent flag; rank only governs ties / non-urgent order).
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

  const handleDelete = async (item: FeatureRequest) => {
    if (!window.confirm(`Delete “${item.title}”? This can't be undone.`)) return
    await removeFeatureRequest(item.id)
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
          <label className="updates-filter-toggle">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(event) => setHideDone(event.target.checked)}
            />
            Hide Done / Won&apos;t do
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="muted-text updates-empty">
            No updates yet. Add one above, or send one from the assistant — they show up here.
          </p>
        ) : (
          <div className="updates-list">
            {visible.map((item) => {
              const closed = CLOSED_STATUSES.has(item.status)
              const refine = refineState[item.id]
              const classes = ['updates-card']
              if (item.urgent) classes.push('urgent')
              if (closed) classes.push('closed')
              if (draggingId === item.id) classes.push('dragging')
              if (dropTargetId === item.id) classes.push('drop-target')
              return (
                <div
                  key={item.id}
                  className={classes.join(' ')}
                  draggable
                  onDragStart={(event) => handleDragStart(event, item.id)}
                  onDragOver={(event) => handleDragOver(event, item.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(event) => handleDrop(event, item.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div className="updates-card-main">
                    <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
                      <GripVertical size={14} />
                    </span>
                    <div className="updates-card-body">
                      <div className="updates-card-titlerow">
                        <input
                          className="updates-title-input"
                          type="text"
                          value={item.title}
                          maxLength={120}
                          aria-label="Title"
                          onChange={(event) =>
                            void updateFeatureRequest(item.id, { title: event.target.value })
                          }
                        />
                        <button
                          type="button"
                          className={`updates-urgent-toggle${item.urgent ? ' active' : ''}`}
                          aria-pressed={item.urgent}
                          title={item.urgent ? 'Urgent — pinned to top' : 'Flag as urgent'}
                          onClick={() =>
                            void updateFeatureRequest(item.id, { urgent: !item.urgent })
                          }
                        >
                          <Star size={15} aria-hidden="true" />
                        </button>
                      </div>

                      <div className="updates-card-meta">
                        <TypeBadge type={item.type} />
                        <select
                          className="updates-status-select"
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
                      </div>

                      <textarea
                        className="updates-description-input"
                        value={item.description}
                        maxLength={2000}
                        rows={3}
                        aria-label="Description"
                        onChange={(event) =>
                          void updateFeatureRequest(item.id, { description: event.target.value })
                        }
                      />

                      {refine?.suggestion ? (
                        <div className="updates-refine-panel">
                          <p className="updates-refine-kicker">Suggested rewrite</p>
                          <strong>{refine.suggestion.title}</strong>
                          <pre className="updates-refine-description">
                            {refine.suggestion.description}
                          </pre>
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
                      {refine?.error ? (
                        <p className="updates-form-error">{refine.error}</p>
                      ) : null}

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
                          onClick={() =>
                            void copyText(formatRequestForClaude(item), `item-${item.id}`)
                          }
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
            })}
          </div>
        )}
      </div>
    </section>
  )
}
