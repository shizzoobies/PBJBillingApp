import { useEffect, useState } from 'react'
import { useAppContext } from '../AppContext'
import { listAttachedPendingNotesRequest } from '../lib/api'
import type { ClientPendingNote } from '../lib/types'

const NO_NOTES: ClientPendingNote[] = []

/**
 * The notes attached to a PAGE of checklists (featreq-b688e73c), fetched ONCE
 * for all of them - a page asks for the cards it renders, and the cards never
 * fetch. Returns a lookup, `notesFor(checklistId)`, that is stable while the
 * answer is.
 *
 * Refetches when the set of ids changes and on the live-sync signal
 * (`dataRefreshCount`), which is how a note that attached on another tab's
 * read or save shows up on an already-open page. A failed fetch keeps what is
 * already on screen rather than blanking it.
 *
 * Pass only real checklists: a projected (not yet materialized) card has no id
 * the server knows.
 */
export function useAttachedClientNotes(checklistIds: string[]) {
  const { dataRefreshCount = 0 } = useAppContext()
  const [byChecklist, setByChecklist] = useState<Map<string, ClientPendingNote[]>>(new Map())

  // Order-insensitive identity for the id set, so a re-sort does not refetch.
  const key = [...new Set(checklistIds.filter(Boolean))].sort().join(',')

  useEffect(() => {
    if (!key) return
    let cancelled = false
    void listAttachedPendingNotesRequest(key.split(','))
      .then((notes) => {
        if (cancelled) return
        const grouped = new Map<string, ClientPendingNote[]>()
        for (const note of notes) {
          if (!note.attachedChecklistId) continue
          const list = grouped.get(note.attachedChecklistId) ?? []
          list.push(note)
          grouped.set(note.attachedChecklistId, list)
        }
        setByChecklist(grouped)
      })
      .catch(() => {
        /* keep what is shown; the next signal retries */
      })
    return () => {
      cancelled = true
    }
  }, [key, dataRefreshCount])

  return (checklistId: string): ClientPendingNote[] => byChecklist.get(checklistId) ?? NO_NOTES
}
