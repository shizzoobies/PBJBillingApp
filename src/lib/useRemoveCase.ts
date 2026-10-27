import { useState } from 'react'
import { useAppContext } from '../AppContext'
import { removeCaseConfirmText } from '../../lib/case-removal.js'

/**
 * Which case a removal is about. A case id alone is not unique (a recipe copy
 * made by the 2026-08-14 import kept its case ids, so one id can hold steps of
 * two clients), so the client is part of the key.
 */
export function caseRemovalKey(caseId: string, clientId: string) {
  return `${clientId}::${caseId}`
}

/** A case this view removed, kept so its "Case removed ... Undo" line outlives the row. */
export type RemovedCase = {
  key: string
  caseId: string
  clientId: string
  title: string
  clientName: string
  /** Any one removed step: restoring it brings the whole case back. */
  restoreId: string
  /** How many steps went to the bin. */
  stepCount: number
}

export type RemoveCaseInput = {
  caseId: string
  clientId: string
  title: string
  clientName: string
  stepCount: number
}

/**
 * Remove case (2026-10-27, Alex for Brittany: "since she is owner she should be
 * able to just remove the case"), pressed from the Dashboard's case rows and the
 * case page. Asks first (`removeCaseConfirmText`), then the context's
 * `removeCase` (POST /api/cases/:id/remove with the client, merged into the
 * workspace, so the row leaves without a reload). `removed` holds what was
 * removed for the "Case removed ... Undo" line; `undo` restores one of its
 * steps, which brings the whole case back from the recycle bin, and answers
 * whether it worked - a failed restore keeps the line and says why
 * (`undoError`). `error` holds the server's sentence for a refused removal.
 * Every state is keyed by `caseRemovalKey(caseId, clientId)`.
 */
export function useRemoveCase() {
  const { removeCase, restoreChecklist } = useAppContext()
  const [removing, setRemoving] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [removed, setRemoved] = useState<RemovedCase[]>([])
  const [error, setError] = useState<{ key: string; text: string } | null>(null)
  const [undoError, setUndoError] = useState<{ key: string; text: string } | null>(null)

  const remove = async (input: RemoveCaseInput) => {
    if (!window.confirm(removeCaseConfirmText(input))) return null
    const key = caseRemovalKey(input.caseId, input.clientId)
    setRemoving(key)
    setError(null)
    try {
      const result = await removeCase(input.caseId, input.clientId)
      if (!result || result.removed.length === 0) return null
      const entry: RemovedCase = {
        key,
        caseId: input.caseId,
        clientId: input.clientId,
        title: input.title,
        clientName: input.clientName,
        restoreId: result.removed[0],
        stepCount: result.removed.length,
      }
      setRemoved((current) => [...current.filter((item) => item.key !== key), entry])
      return entry
    } catch (caught) {
      const text = caught instanceof Error && caught.message ? caught.message : 'The case could not be removed.'
      setError({ key, text })
      return null
    } finally {
      setRemoving(null)
    }
  }

  const undo = async (key: string) => {
    const entry = removed.find((item) => item.key === key)
    if (!entry) return false
    setRestoring(key)
    setUndoError(null)
    try {
      const outcome = await restoreChecklist(entry.restoreId)
      if (!outcome.ok) {
        setUndoError({ key, text: outcome.message })
        return false
      }
      setRemoved((current) => current.filter((item) => item.key !== key))
      return true
    } finally {
      setRestoring(null)
    }
  }

  return { removing, restoring, removed, error, undoError, remove, undo }
}
