import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DASHBOARD_PANELS,
  defaultDashboardLayout,
  moveDashboardPanel,
  sanitizeDashboardLayout,
  setDashboardPanelFlag,
  type DashboardLayout,
  type DashboardPanelKey,
  type DashboardView,
} from '../../lib/dashboard-layout.js'
import { fetchDashboardLayout, saveDashboardLayoutRequest } from './api'

/**
 * The Dashboard's per-person arrangement (2026-10-27): panel order, shown or
 * hidden, and whether each panel starts open or collapsed. Saved on the user
 * (`GET/PUT /api/me/dashboard-layout`); the rules live in lib/dashboard-layout.js,
 * the panels and the Arrange list in src/components/DashboardLayout.tsx.
 *
 * - The saved layout says how each panel STARTS. A press of a panel's chevron
 *   lasts for this visit only (kept in memory, never saved).
 * - Arrange edits a draft; Done saves it in one request (none when unchanged).
 * - Preview reads the previewed person's saved layout, read-only.
 */

/** Panels that fetch their own data: mounted only once the saved layout is known. */
export const SELF_FETCHING_PANELS = new Set<DashboardPanelKey>(['past_due'])

/**
 * The last layout this browser saw for a person, so the Dashboard opens in her
 * order instead of the default order and then jumping. Only a first paint hint:
 * the server's answer always replaces it.
 */
const hintKey = (userId: string) => `pbj.dashboardLayout.${userId}`

function readHint(userId: string): unknown {
  try {
    const raw = window.localStorage.getItem(hintKey(userId))
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function writeHint(userId: string, layout: DashboardLayout) {
  try {
    window.localStorage.setItem(hintKey(userId), JSON.stringify(layout))
  } catch {
    // localStorage may be unavailable (private mode / quota): only the hint is lost.
  }
}

/**
 * Chevron presses for this visit: `${userId}|${view}|${panel}` -> collapsed.
 * Module memory, so it survives leaving the Dashboard and coming back, and is
 * gone on a reload. Never saved.
 */
const collapseMemory = new Map<string, boolean>()

/** Forget every chevron press (tests, and after a saved arrangement replaces them). */
export function forgetDashboardCollapseMemory(prefix = '') {
  for (const key of [...collapseMemory.keys()]) {
    if (key.startsWith(prefix)) collapseMemory.delete(key)
  }
}

export function dashboardPanelLabel(view: DashboardView, key: DashboardPanelKey) {
  return DASHBOARD_PANELS[view].find((panel) => panel.key === key)?.label ?? key
}

export type DashboardArrangement = {
  view: DashboardView
  readOnly: boolean
  /** The saved layout (the default until the server answers, unless a hint is on hand). */
  layout: DashboardLayout
  /** True once the saved layout is known: a hint was on hand or the server answered. */
  known: boolean
  /**
   * True only once the server has answered with the saved layout. Arrange waits
   * for it: a draft built from the default or the hint would overwrite her
   * saved arrangement on Done.
   */
  serverAnswered: boolean
  /** The GET failed: Arrange stays off until a reload. */
  loadFailed: boolean
  /** The layout being arranged, or null outside Arrange. */
  draft: DashboardLayout | null
  saving: boolean
  error: string | null
  shows: (key: DashboardPanelKey) => boolean
  isCollapsed: (key: DashboardPanelKey) => boolean
  toggleCollapsed: (key: DashboardPanelKey) => void
  startArranging: () => void
  cancelArranging: () => void
  resetDraft: () => void
  moveInDraft: (key: DashboardPanelKey, direction: -1 | 1) => void
  setDraftFlag: (key: DashboardPanelKey, flag: 'hidden' | 'collapsed', value: boolean) => void
  saveDraft: () => Promise<void>
}

/**
 * The Dashboard's arrangement for `userId` on `view`. `readOnly` (preview):
 * the layout is read from the server each time, never cached, never saved.
 */
export function useDashboardArrangement({
  view,
  userId,
  readOnly,
}: {
  view: DashboardView
  userId: string
  readOnly: boolean
}): DashboardArrangement {
  const [loaded, setLoaded] = useState(() => {
    const hint = readOnly ? null : readHint(userId)
    return {
      userId,
      layout: sanitizeDashboardLayout(hint, view),
      known: hint !== null,
      serverAnswered: false,
      loadFailed: false,
    }
  })
  // A previewed person can change while the view stays mounted: start over.
  if (loaded.userId !== userId) {
    const hint = readOnly ? null : readHint(userId)
    setLoaded({ userId, layout: sanitizeDashboardLayout(hint, view), known: hint !== null, serverAnswered: false, loadFailed: false })
  }
  // Bumped by every save: a GET that set out before it answers with the layout
  // the save just replaced, so its answer is dropped.
  const saveGeneration = useRef(0)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState<DashboardLayout | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const startedAt = saveGeneration.current
    void (async () => {
      try {
        const { layout } = await fetchDashboardLayout(controller.signal)
        if (cancelled) return
        if (saveGeneration.current !== startedAt) {
          // A save landed meanwhile and is newer than this answer.
          setLoaded((current) => (current.userId === userId ? { ...current, serverAnswered: true } : current))
          return
        }
        const clean = sanitizeDashboardLayout(layout, view)
        if (!readOnly) writeHint(userId, clean)
        setLoaded({ userId, layout: clean, known: true, serverAnswered: true, loadFailed: false })
      } catch {
        // Non-fatal: the Dashboard keeps the hint or the default (not arrangeable).
        if (!cancelled) {
          setLoaded((current) => (current.userId === userId ? { ...current, known: true, loadFailed: true } : current))
        }
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [userId, view, readOnly])

  const layout = loaded.layout
  const memoryPrefix = `${userId}|${view}|`

  const isCollapsed = (key: DashboardPanelKey) => {
    const pressed = overrides[memoryPrefix + key] ?? collapseMemory.get(memoryPrefix + key)
    if (typeof pressed === 'boolean') return pressed
    return layout.panels.find((panel) => panel.key === key)?.collapsed === true
  }

  const toggleCollapsed = (key: DashboardPanelKey) => {
    const next = !isCollapsed(key)
    collapseMemory.set(memoryPrefix + key, next)
    setOverrides((current) => ({ ...current, [memoryPrefix + key]: next }))
  }

  const saveDraft = useCallback(async () => {
    if (!draft || readOnly) return
    if (JSON.stringify(draft) === JSON.stringify(layout)) {
      setDraft(null)
      return
    }
    setSaving(true)
    setError(null)
    saveGeneration.current += 1
    try {
      const { layout: stored } = await saveDashboardLayoutRequest(draft)
      const clean = sanitizeDashboardLayout(stored, view)
      writeHint(userId, clean)
      // The new "starts open / collapsed" choices take effect now.
      forgetDashboardCollapseMemory(memoryPrefix)
      setOverrides({})
      setLoaded({ userId, layout: clean, known: true, serverAnswered: true, loadFailed: false })
      setDraft(null)
    } catch {
      setError('Your arrangement could not be saved. Try Done again.')
    } finally {
      setSaving(false)
    }
  }, [draft, layout, memoryPrefix, readOnly, userId, view])

  return {
    view,
    readOnly,
    layout,
    known: loaded.known,
    serverAnswered: loaded.serverAnswered,
    loadFailed: loaded.loadFailed,
    draft,
    saving,
    error,
    shows: (key) => layout.panels.some((panel) => panel.key === key && !panel.hidden),
    isCollapsed,
    toggleCollapsed,
    startArranging: () => {
      if (readOnly || !loaded.serverAnswered) return
      setError(null)
      setDraft(layout)
    },
    cancelArranging: () => {
      setError(null)
      setDraft(null)
    },
    resetDraft: () => setDraft(defaultDashboardLayout(view)),
    moveInDraft: (key, direction) =>
      setDraft((current) => (current ? moveDashboardPanel(current, key, direction, view) : current)),
    setDraftFlag: (key, flag, value) =>
      setDraft((current) => (current ? setDashboardPanelFlag(current, key, flag, value, view) : current)),
    saveDraft,
  }
}

