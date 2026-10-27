import { useState } from 'react'
import { useAppContext } from '../AppContext'
import { openNextStageErrorText } from './stalledCase'
import type { Checklist } from './types'

/**
 * Open next step now for a finished step whose next step never opened, pressed
 * from OUTSIDE its card: the Dashboard's stalled row and the case page
 * (featreq-9c818fca). The same action as the card's button - the context's
 * `openNextStageEarly` (POST /api/checklists/:id/open-next-stage, merged into
 * the workspace) - with the same states: `opening` while it runs ("Opening…"),
 * `error` holding the server's sentence on a refusal. `onOpened` gets the new
 * step; nothing is called when the action was a no-op (preview).
 */
export function useOpenNextStage(checklistId: string, onOpened: (spawned: Checklist) => void) {
  const { openNextStageEarly } = useAppContext()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    setOpening(true)
    setError(null)
    try {
      const spawned = await openNextStageEarly(checklistId)
      if (spawned) onOpened(spawned)
    } catch (caught) {
      setError(openNextStageErrorText(caught))
    } finally {
      setOpening(false)
    }
  }
  return { opening, error, open }
}
