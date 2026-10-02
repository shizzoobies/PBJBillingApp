import { useCallback, useEffect, useState } from 'react'
import { useAppContext } from '../AppContext'
import { listClientPendingNotesRequest } from '../lib/api'
import type { ClientPendingNote } from '../lib/types'

type Loaded = { clientId: string; notes: ClientPendingNote[] }

/**
 * A client's pending notes (featreq-b688e73c): pending, plus attached in the
 * last 90 days. Owned by whoever needs the COUNT (the client page's section
 * header) and handed down to the notes box - so the count shows while the box
 * is collapsed and unmounted, and an open box does not fetch a second copy.
 *
 * Refetches on the live-sync signal (`dataRefreshCount`), not on the `data`
 * reference, which also changes on every local edit. Rows already on screen
 * stay put while a refetch is in flight: `loading` is true only until the
 * FIRST answer for this client.
 *
 * `enabled: false` makes the hook inert (a box handed someone else's state).
 */
export function useClientPendingNotes(clientId: string, enabled = true) {
  const { dataRefreshCount = 0 } = useAppContext()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled || !clientId) return
    let cancelled = false
    void (async () => {
      // A previous client's load error must not carry over to this one.
      setError('')
      try {
        const list = await listClientPendingNotesRequest(clientId)
        if (cancelled) return
        setLoaded({ clientId, notes: list })
        setError('')
      } catch {
        if (!cancelled) setError('Could not load pending notes.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [clientId, enabled, dataRefreshCount])

  // Another client's rows are never shown under this one while it loads.
  const current = loaded?.clientId === clientId ? loaded.notes : null

  const setNotes = useCallback(
    (update: (notes: ClientPendingNote[]) => ClientPendingNote[]) => {
      setLoaded((previous) =>
        previous && previous.clientId === clientId
          ? { clientId, notes: update(previous.notes) }
          : { clientId, notes: update([]) },
      )
    },
    [clientId],
  )

  return {
    notes: current ?? [],
    /** True only until the first answer for this client. */
    loading: enabled && current === null && !error,
    error,
    setNotes,
  }
}

export type ClientPendingNotesState = ReturnType<typeof useClientPendingNotes>

/**
 * How many of a client's notes are still waiting for a checklist. A repeating
 * note is a standing one (it is never "waiting" for its one checklist), so it is
 * not counted here.
 */
export function pendingNoteCount(notes: ClientPendingNote[]) {
  return notes.filter((note) => !note.attachedChecklistId && !note.repeats).length
}
