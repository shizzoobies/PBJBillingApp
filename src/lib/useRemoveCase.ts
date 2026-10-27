import { useState } from 'react'
import { useAppContext } from '../AppContext'
import { removeCaseConfirmText } from '../../lib/case-removal.js'

/** A case this view removed, kept so its "Case removed. Undo" line outlives the row. */
export type RemovedCase = {
  caseId: string
  title: string
  clientName: string
  /** Any one removed step: restoring it brings the whole case back. */
  restoreId: string
  /** How many steps went to the bin. */
  stepCount: number
}

export type RemoveCaseInput = { caseId: string; title: string; clientName: string; stepCount: number }

/**
 * Remove case (2026-10-27, Alex for Brittany: "since she is owner she should be
 * able to just remove the case"), pressed from the Dashboard's case rows and the
 * case page. Asks first (`removeCaseConfirmText`), then the context's
 * `removeCase` (POST /api/cases/:id/remove, merged into the workspace, so the
 * row leaves without a reload). `removed` holds what was removed for the
 * "Case removed. Undo" line; `undo` restores one of its steps, which brings the
 * whole case back from the recycle bin. `error` holds the server's sentence.
 */
export function useRemoveCase() {
  const { removeCase, restoreChecklist } = useAppContext()
  const [removing, setRemoving] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [removed, setRemoved] = useState<RemovedCase[]>([])
  const [error, setError] = useState<{ caseId: string; text: string } | null>(null)

  const remove = async (input: RemoveCaseInput) => {
    if (!window.confirm(removeCaseConfirmText(input))) return null
    setRemoving(input.caseId)
    setError(null)
    try {
      const result = await removeCase(input.caseId)
      if (!result || result.removed.length === 0) return null
      const entry: RemovedCase = {
        caseId: input.caseId,
        title: input.title,
        clientName: input.clientName,
        restoreId: result.removed[0],
        stepCount: result.removed.length,
      }
      setRemoved((current) => [...current.filter((item) => item.caseId !== input.caseId), entry])
      return entry
    } catch (caught) {
      const text = caught instanceof Error && caught.message ? caught.message : 'The case could not be removed.'
      setError({ caseId: input.caseId, text })
      return null
    } finally {
      setRemoving(null)
    }
  }

  const undo = async (caseId: string) => {
    const entry = removed.find((item) => item.caseId === caseId)
    if (!entry) return
    setRestoring(caseId)
    try {
      await restoreChecklist(entry.restoreId)
      setRemoved((current) => current.filter((item) => item.caseId !== caseId))
    } finally {
      setRestoring(null)
    }
  }

  return { removing, restoring, removed, error, remove, undo }
}
