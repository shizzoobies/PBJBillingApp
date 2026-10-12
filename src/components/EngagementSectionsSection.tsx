import { useEffect, useMemo, useRef, useState } from 'react'
import { CollapsibleSection, SaveBadge } from './SectionKit'
import { BoldBar, PlaceholderChipsToggle } from './letters/LetterEditorKit'
import { insertPlaceholder, isBoldShortcut, toggleBold, unknownPlaceholderSentence } from './letters/letterEditing'
import { listEngagementSectionsRequest, saveEngagementSectionsRequest } from '../lib/api'
import type { SaveFlashState } from '../lib/useSaveFlash'
import { ApiError, type EngagementSection, type EngagementSectionTrigger, type ProposalPricing } from '../lib/types'
import { placeholdersFor, retiredSentence, templateWarnings } from '../../lib/letter-template.js'
import { PROPOSAL_GROUPS } from '../../lib/proposal-pricing.js'

/** One section as the page edits it: `uid` keys the row; `saved` = the server knows the key. */
type Row = {
  uid: string
  key: string
  title: string
  body: string
  trigger: { always: boolean; groups: string[]; serviceIds: string[] }
  active: boolean
  saved: boolean
}

const KEY_SHAPE = /^[a-z0-9_]{1,40}$/

function toRow(section: EngagementSection): Row {
  return {
    uid: section.id || section.key,
    key: section.key,
    title: section.title,
    body: section.body,
    trigger: {
      always: section.trigger?.always === true,
      groups: [...(section.trigger?.groups ?? [])],
      serviceIds: [...(section.trigger?.serviceIds ?? [])],
    },
    active: section.active !== false,
    saved: true,
  }
}

/** The library as the server stores it, in the page's order. */
function toPayload(rows: Row[]) {
  return rows.map((row, index) => {
    const trigger: EngagementSectionTrigger = {}
    if (row.trigger.always) trigger.always = true
    if (row.trigger.groups.length > 0) trigger.groups = row.trigger.groups
    if (row.trigger.serviceIds.length > 0) trigger.serviceIds = row.trigger.serviceIds
    return {
      key: row.key,
      title: row.title,
      body: row.body,
      trigger,
      sortOrder: index + 1,
      active: row.active,
    }
  })
}

const ENGAGEMENT_PLACEHOLDERS = placeholdersFor('engagement')

/**
 * Settings > Engagement sections (docs/plans/engagements-2026-10.md, stage 2C): the
 * library an engagement letter is assembled from when a proposal is accepted. Each
 * section says when it goes in (always, a service group on the proposal, or one
 * service line); the `email` section is the cover email. Save all sends the whole
 * list; a section is never deleted, only switched off.
 */
export function EngagementSectionsSection({ pricing }: { pricing: ProposalPricing }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [savedRows, setSavedRows] = useState<Row[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<SaveFlashState>('idle')
  const [saveError, setSaveError] = useState('')
  const bodyRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const nextNumber = useRef(1)

  useEffect(() => {
    let cancelled = false
    void listEngagementSectionsRequest()
      .then((sections) => {
        if (cancelled) return
        const loaded = sections.map(toRow)
        setRows(loaded)
        setSavedRows(loaded)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load the engagement sections.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const services = useMemo(
    () =>
      [...(pricing.services ?? [])]
        .filter((service) => service.active !== false)
        .sort((a, b) => a.group.localeCompare(b.group) || a.sortOrder - b.sortOrder),
    [pricing.services],
  )
  const serviceLabel = (id: string) => {
    const service = (pricing.services ?? []).find((entry) => entry.id === id)
    if (!service) return `${id} (no longer in the catalog)`
    return `${service.group}: ${service.name}${service.tier ? ` ${service.tier}` : ''}`
  }

  const dirty = rows !== null && savedRows !== null && JSON.stringify(toPayload(rows)) !== JSON.stringify(toPayload(savedRows))
  const keyProblems = (rows ?? []).filter(
    (row, index, all) => !KEY_SHAPE.test(row.key) || all.findIndex((other) => other.key === row.key) !== index,
  )

  const update = (uid: string, patch: Partial<Row>) =>
    setRows((current) => (current ?? []).map((row) => (row.uid === uid ? { ...row, ...patch } : row)))
  const setTrigger = (uid: string, patch: Partial<Row['trigger']>) =>
    setRows((current) =>
      (current ?? []).map((row) => (row.uid === uid ? { ...row, trigger: { ...row.trigger, ...patch } } : row)),
    )
  const move = (uid: string, by: -1 | 1) =>
    setRows((current) => {
      const list = [...(current ?? [])]
      const at = list.findIndex((row) => row.uid === uid)
      const to = at + by
      if (at < 0 || to < 0 || to >= list.length) return current
      ;[list[at], list[to]] = [list[to], list[at]]
      return list
    })
  const add = () =>
    setRows((current) => {
      const list = current ?? []
      let n = nextNumber.current
      while (list.some((row) => row.key === `section_${n}`)) n += 1
      nextNumber.current = n + 1
      return [
        ...list,
        {
          uid: `new-${n}`,
          key: `section_${n}`,
          title: 'New section',
          body: '',
          trigger: { always: false, groups: [], serviceIds: [] },
          active: true,
          saved: false,
        },
      ]
    })

  const save = async () => {
    if (!rows || keyProblems.length > 0) return
    setSaveState('saving')
    setSaveError('')
    try {
      const sections = await saveEngagementSectionsRequest(toPayload(rows))
      const loaded = sections.map(toRow)
      setRows(loaded)
      setSavedRows(loaded)
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1800)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the engagement sections.')
    }
  }

  return (
    <CollapsibleSection kicker="Engagements" title="Engagement sections" lockable>
      <p className="muted-text" style={{ marginTop: 0 }}>
        When you accept a proposal, its engagement letter is put together from these sections, in this order: each
        section goes in when it is set to Always, when the proposal has a service in one of its groups, or when the
        proposal has one of its service lines. The Email section is the cover email. Changing a section here changes
        letters drafted from now on; a letter already drafted keeps its text until you re-assemble it.
      </p>
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {rows === null && !loadError ? <p className="muted-text">Loading the sections...</p> : null}

      {(rows ?? []).map((row, index) => {
        const isEmail = row.key === 'email'
        const warnings = templateWarnings({ letterBody: row.body }, ENGAGEMENT_PLACEHOLDERS)
        const label = row.title || row.key
        const box = () => bodyRefs.current.get(row.uid) ?? null
        const setBody = (body: string) => update(row.uid, { body })
        return (
          <div
            key={row.uid}
            className={`engagement-section-row${row.active ? '' : ' is-inactive'}`}
            role="group"
            aria-label={`Section ${label}`}
          >
            <div className="button-row">
              <strong>{`${index + 1}. ${label}`}</strong>
              {isEmail ? <span className="status-pill">Cover email</span> : null}
              {row.active ? null : <span className="status-pill">Off</span>}
              <button
                type="button"
                className="ghost-action"
                aria-label={`Move ${label} up`}
                disabled={index === 0}
                onClick={() => move(row.uid, -1)}
              >
                Up
              </button>
              <button
                type="button"
                className="ghost-action"
                aria-label={`Move ${label} down`}
                disabled={index === (rows ?? []).length - 1}
                onClick={() => move(row.uid, 1)}
              >
                Down
              </button>
              {isEmail ? null : (
                // The cover email is always in use: every letter needs one (the server keeps it on too).
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={`Use ${label}`}
                    checked={row.active}
                    onChange={(event) => update(row.uid, { active: event.target.checked })}
                  />
                  <span>In use</span>
                </label>
              )}
            </div>
            <div className="form-grid two-col">
              <label className="field">
                <span>Title</span>
                <input
                  className="input"
                  type="text"
                  maxLength={120}
                  aria-label={`Title of ${label}`}
                  value={row.title}
                  onChange={(event) => update(row.uid, { title: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Key</span>
                <input
                  className="input"
                  type="text"
                  maxLength={40}
                  aria-label={`Key of ${label}`}
                  readOnly={row.saved}
                  value={row.key}
                  onChange={(event) => update(row.uid, { key: event.target.value.trim().toLowerCase() })}
                />
              </label>
            </div>
            {!KEY_SHAPE.test(row.key) ? (
              <p className="form-error" role="alert">
                A key is lowercase letters, numbers and underscores, at most 40.
              </p>
            ) : null}

            {isEmail ? null : (
              <div className="engagement-section-trigger" role="group" aria-label={`When ${label} goes in`}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={row.trigger.always}
                    onChange={(event) => setTrigger(row.uid, { always: event.target.checked })}
                  />
                  <span>Always</span>
                </label>
                {PROPOSAL_GROUPS.map((group) => (
                  <label key={group} className="check-row">
                    <input
                      type="checkbox"
                      checked={row.trigger.groups.includes(group)}
                      disabled={row.trigger.always}
                      onChange={(event) =>
                        setTrigger(row.uid, {
                          groups: event.target.checked
                            ? [...row.trigger.groups, group]
                            : row.trigger.groups.filter((entry) => entry !== group),
                        })
                      }
                    />
                    <span>{group}</span>
                  </label>
                ))}
                <label className="field">
                  <span>Or when the proposal has this service line</span>
                  <select
                    className="input"
                    aria-label={`Add a service line to ${label}`}
                    disabled={row.trigger.always}
                    value=""
                    onChange={(event) => {
                      const id = event.target.value
                      if (id && !row.trigger.serviceIds.includes(id)) {
                        setTrigger(row.uid, { serviceIds: [...row.trigger.serviceIds, id] })
                      }
                    }}
                  >
                    <option value="">Choose a service line...</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {serviceLabel(service.id)}
                      </option>
                    ))}
                  </select>
                </label>
                {row.trigger.serviceIds.length > 0 ? (
                  <div className="button-row" role="list" aria-label={`Service lines ${label} follows`}>
                    <span className="muted-text">Service lines:</span>
                    {row.trigger.serviceIds.map((id) => (
                      <span key={id} className="status-pill" role="listitem">
                        {serviceLabel(id)}{' '}
                        <button
                          type="button"
                          className="ghost-action"
                          aria-label={`Remove ${serviceLabel(id)} from ${label}`}
                          disabled={row.trigger.always}
                          onClick={() =>
                            setTrigger(row.uid, { serviceIds: row.trigger.serviceIds.filter((entry) => entry !== id) })
                          }
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {!row.trigger.always && row.trigger.groups.length === 0 && row.trigger.serviceIds.length === 0 ? (
                  <p className="muted-text">Nothing is ticked, so this section never goes into a letter.</p>
                ) : null}
              </div>
            )}

            <div className="field">
              <label htmlFor={`engagement-section-body-${row.uid}`}>
                <span>{isEmail ? 'Email text' : 'Section text'}</span>
              </label>
              <BoldBar fieldWord={`text of ${label}`} disabled={false} onBold={() => toggleBold(box, row.body, setBody)} />
              <textarea
                id={`engagement-section-body-${row.uid}`}
                ref={(element) => {
                  if (element) bodyRefs.current.set(row.uid, element)
                  else bodyRefs.current.delete(row.uid)
                }}
                className="input"
                rows={isEmail ? 6 : 8}
                maxLength={20000}
                value={row.body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (isBoldShortcut(event)) {
                    event.preventDefault()
                    toggleBold(box, row.body, setBody)
                  }
                }}
              />
            </div>
            <PlaceholderChipsToggle
              placeholders={ENGAGEMENT_PLACEHOLDERS}
              fieldWord={`text of ${label}`}
              onInsert={(key) => insertPlaceholder(box, row.body, key, setBody)}
            />
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
          </div>
        )
      })}

      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}
      {keyProblems.length > 0 ? (
        <p className="form-error" role="alert">
          Every section needs its own key (lowercase letters, numbers and underscores) before saving.
        </p>
      ) : null}
      <div className="button-row">
        <button type="button" className="secondary-action" disabled={rows === null} onClick={add}>
          Add section
        </button>
        <button
          type="button"
          className="primary-action"
          disabled={!dirty || saveState === 'saving' || keyProblems.length > 0}
          onClick={() => void save()}
        >
          Save all
        </button>
        <SaveBadge state={saveState} />
      </div>
    </CollapsibleSection>
  )
}
