import { useCallback, useEffect, useRef, useState } from 'react'
import type { Checklist } from '../lib/types'

/**
 * Why "Start the first one now" did not start a new recipe's Step 1
 * (src/lib/recipeFirstStep.ts), for the page that created the recipe.
 *
 * - It goes away once the recipe HAS a checklist (Generate a task now, or the
 *   schedule reaching it): derived from `checklists`, so there is nothing to
 *   keep in sync.
 * - `show` is ignored after the page unmounts, since the answer can arrive
 *   after a save and a server round trip, when the owner has moved on.
 */
export function useStartFirstNote(checklists: Checklist[]) {
  const [note, setNote] = useState<{ templateId: string; text: string } | null>(null)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const show = useCallback((templateId: string, text: string) => {
    if (mountedRef.current) setNote({ templateId, text })
  }, [])
  const dismiss = useCallback(() => setNote(null), [])
  const resolved =
    note !== null && checklists.some((checklist) => checklist.templateId === note.templateId)
  return { text: note && !resolved ? note.text : null, show, dismiss }
}
