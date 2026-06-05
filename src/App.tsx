import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import './App.css'
import { AppContext, useAppContext, type AppContextValue } from './AppContext'
import { AppLayout } from './components/AppLayout'
import { SignInScreen } from './components/SignInScreen'
import {
  addChecklistSubItemRequest,
  addChecklistSubSubItemRequest,
  appendChecklistItemsRequest,
  applyTemplateToClientRequest,
  approveTimeEntriesBatchRequest,
  approveTimeEntryRequest,
  createChecklistRequest,
  createStandardTemplateRequest,
  createTimeEntry,
  deleteChecklistItemRequest,
  deleteChecklistRequest,
  emptyChecklistRecycleBinRequest,
  restoreChecklistRequest,
  deleteTeamMember as deleteTeamMemberRequest,
  deleteTimeEntryRequest,
  fetchAppData,
  fetchFirmSettings,
  fetchPublicFirmSettings,
  fetchSession,
  generateChecklistFromTemplateRequest,
  addRecurringReimbursementRequest,
  addReimbursementRequest,
  approveWeeklySubmissionRequest,
  deletePlanRequest,
  deleteRecurringReimbursementRequest,
  deleteReimbursementRequest,
  lockTimesheetRequest,
  rejectWeeklySubmissionRequest,
  submitWeeklyTimesheetRequest,
  updateRecurringReimbursementRequest,
  updateReimbursementRequest,
  logoutSession,
  rejectTimeEntryRequest,
  removeChecklistSubItemRequest,
  removeChecklistSubSubItemRequest,
  reorderChecklistItemsRequest,
  saveAppData,
  setChecklistViewersRequest,
  setPreviewModeActive,
  setTemplateViewersRequest,
  toggleChecklistItemRequest,
  unlockTimesheetRequest,
  updateChecklistItemRequest,
  updateTimeEntryRequest,
} from './lib/api'
import { createEmptyAppData } from './lib/seed'
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type AppData,
  type AuthState,
  type BillingMode,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
  type Client,
  type Contact,
  type DataSyncState,
  type FirmSettings,
  type PublicFirmSettings,
  type SessionUser,
  type SubscriptionPlan,
  type TimeEntry,
  type TimerState,
} from './lib/types'
import {
  allocateGroupMinutes,
  currentBillingPeriod,
  ensureRecurringChecklists,
  formatTimeFromMs,
  getAssignedEmployeeIds,
  type GroupAllocationMode,
  makeId,
  sortChecklists,
} from './lib/utils'
import { CaseDetailPage } from './pages/CaseDetailPage'
import { ChecklistsPage } from './pages/ChecklistsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ClientDetailPage } from './pages/ClientDetailPage'
import { ClientsPage } from './pages/ClientsPage'
import { ContactsPage } from './pages/ContactsPage'
import { GanttPage } from './pages/GanttPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { PlansPage } from './pages/PlansPage'
import { ProductivityPage } from './pages/ProductivityPage'
import { ReportsPage } from './pages/ReportsPage'
import { SettingsPage } from './pages/SettingsPage'
import { TeamPage } from './pages/TeamPage'
import { TimePage } from './pages/TimePage'
import { TimesheetPage } from './pages/TimesheetPage'
import { TimeApprovalsPage } from './pages/TimeApprovalsPage'
import { SecurityPage } from './pages/SecurityPage'
import { TwoFactorPage } from './pages/TwoFactorPage'
import { TwoFactorSetupPage } from './pages/TwoFactorSetupPage'

function OwnerOnly({
  ownerMode,
  children,
}: {
  ownerMode: boolean
  children: React.ReactElement
}) {
  const { previewMode } = useAppContext()
  if (!ownerMode) {
    // `ownerMode` is the EFFECTIVE role authority, so a non-owner — or an
    // owner previewing a non-owner — bounces off owner-only routes. While
    // previewing, send them to /dashboard (the faithful landing page).
    return <Navigate to={previewMode ? '/dashboard' : '/time'} replace />
  }
  return children
}

function App() {
  // Empty workspace until the server fetch resolves — avoids the flash
  // of stale demo clients / checklists on reload that made just-deleted
  // items briefly reappear before the real data arrived.
  const [data, setData] = useState<AppData>(createEmptyAppData)
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null)
  const [dataSyncState, setDataSyncState] = useState<DataSyncState>('loading')
  const [serverPersistenceEnabled, setServerPersistenceEnabled] = useState(false)
  const [activeEmployeeId, setActiveEmployeeId] = useState('emp-avery')
  const [previewUserId, setPreviewUserId] = useState<string | null>(null)
  const [selectedClientId, setSelectedClientId] = useState('client-northstar')
  const [billingPeriod, setBillingPeriod] = useState(currentBillingPeriod())
  const [timer, setTimer] = useState<TimerState | null>(null)
  const [now, setNow] = useState(0)
  const [firmSettings, setFirmSettings] = useState<FirmSettings>(DEFAULT_FIRM_SETTINGS)
  const [publicFirmSettings, setPublicFirmSettings] = useState<PublicFirmSettings>({
    name: DEFAULT_FIRM_SETTINGS.name,
    tagline: DEFAULT_FIRM_SETTINGS.tagline ?? '',
    logoUrl: DEFAULT_FIRM_SETTINGS.logoUrl ?? '',
    brandColor: DEFAULT_FIRM_SETTINGS.brandColor ?? '#3c2044',
    sidebarTextColor: DEFAULT_FIRM_SETTINGS.sidebarTextColor ?? '#ffffff',
    sidebarActiveTextColor: DEFAULT_FIRM_SETTINGS.sidebarActiveTextColor ?? '#ffffff',
  })
  const skipAutosaveRef = useRef(0)
  // Latched flag that forces the next autosave to fire even when
  // `skipAutosaveRef` is positive. Set by `updateWorkspaceData` (the
  // legacy local-only mutators like `deleteClient` / `addClient` /
  // `addPlan` rely on autosave to actually persist their change). Cleared
  // the moment the autosave effect honors it. Fixes the race where an
  // API-backed mutation incremented the skip counter in the same render
  // window as a local-only delete, swallowing the delete forever.
  const forceNextSaveRef = useRef(false)
  // Real-time sync support: timestamp of the last local workspace edit (so an
  // incoming refetch never clobbers an in-flight edit), plus a live mirror of
  // the sync state readable inside the SSE refetch timer.
  const lastWorkspaceEditRef = useRef(0)
  const dataSyncStateRef = useRef(dataSyncState)
  const role = sessionUser?.role ?? 'employee'

  // Preview mode: an owner is viewing the app AS another user. It is strictly
  // read-only. `previewActiveRef` mirrors it into a ref so the mutation
  // helpers below (which run in event handlers / async callbacks, never
  // during render) can early-out without being re-created each render.
  const previewActive =
    previewUserId !== null && role === 'owner' && Boolean(sessionUser)
  const previewActiveRef = useRef(previewActive)

  // Mirror preview state into the ref AND into api.ts's central fetch wrapper
  // so every request carries the `X-Preview-Mode` header while previewing —
  // the server-side read-only guard.
  useEffect(() => {
    previewActiveRef.current = previewActive
    setPreviewModeActive(previewActive)
  }, [previewActive])

  useEffect(() => {
    dataSyncStateRef.current = dataSyncState
  }, [dataSyncState])

  // Real-time sync: subscribe to the server's change stream and refetch the
  // shared workspace whenever ANOTHER session edits it, so two owners see each
  // other's changes within a moment. The refetch defers while THIS session has
  // an unsaved / in-flight edit, so it never clobbers local work.
  useEffect(() => {
    if (!sessionUser) return
    // EventSource is unavailable in some test/SSR environments — degrade
    // gracefully (the app still works, just without live cross-session sync).
    if (typeof EventSource === 'undefined') return
    let refetchTimer = 0
    let cancelled = false

    const doRefetch = async () => {
      if (cancelled || previewActiveRef.current) return
      try {
        const remote = await fetchAppData(new AbortController().signal, null)
        if (cancelled) return
        // Suppress the autosave echo this setData would otherwise trigger.
        skipAutosaveRef.current += 1
        setData(remote)
        setDataSyncState('synced')
      } catch {
        /* transient — the next ping (or auto-reconnect) retries */
      }
    }

    const attempt = () => {
      if (cancelled) return
      const recentlyEdited = new Date().getTime() - lastWorkspaceEditRef.current < 2500
      const syncState = dataSyncStateRef.current
      if (
        previewActiveRef.current ||
        syncState === 'saving' ||
        syncState === 'loading' ||
        recentlyEdited
      ) {
        // Don't overwrite an active edit — retry once it settles.
        window.clearTimeout(refetchTimer)
        refetchTimer = window.setTimeout(attempt, 1500)
        return
      }
      void doRefetch()
    }

    const schedule = () => {
      window.clearTimeout(refetchTimer)
      refetchTimer = window.setTimeout(attempt, 500)
    }

    const source = new EventSource('/api/events')
    source.addEventListener('data-changed', schedule)

    return () => {
      cancelled = true
      window.clearTimeout(refetchTimer)
      source.close()
    }
  }, [sessionUser])

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      try {
        const sessionResponse = await fetchSession(controller.signal)
        setSessionUser(sessionResponse.user)
        // Default the active employee to whoever is signed in — for OWNERS too.
        // Previously this only fired for employees, so an owner's timer/manual
        // employee picker defaulted to a stale seed id (e.g. another teammate),
        // silently logging the owner's own time under someone else. That made
        // it look like an owner "couldn't approve their own time" because it
        // never appeared under their name in the approval queue.
        if (sessionResponse.user) {
          setActiveEmployeeId(sessionResponse.user.id)
        }
      } catch {
        if (controller.signal.aborted) {
          return
        }
      } finally {
        if (!controller.signal.aborted) {
          setAuthState('ready')
        }
      }
    }

    void load()

    return () => controller.abort()
  }, [])

  // Public firm branding: load once at boot so the login screen, tab title,
  // and brand color reflect the configured firm even before sign-in.
  useEffect(() => {
    const controller = new AbortController()
    fetchPublicFirmSettings(controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return
        setPublicFirmSettings({
          name: settings.name || DEFAULT_FIRM_SETTINGS.name,
          tagline: settings.tagline ?? '',
          logoUrl: settings.logoUrl ?? '',
          brandColor: settings.brandColor || (DEFAULT_FIRM_SETTINGS.brandColor ?? '#3c2044'),
          sidebarTextColor: settings.sidebarTextColor || (DEFAULT_FIRM_SETTINGS.sidebarTextColor ?? '#ffffff'),
          sidebarActiveTextColor:
            settings.sidebarActiveTextColor ||
            (DEFAULT_FIRM_SETTINGS.sidebarActiveTextColor ?? '#ffffff'),
        })
      })
      .catch(() => {
        /* fall back to defaults */
      })
    return () => controller.abort()
  }, [])

  // Owner-authenticated full firm settings (address/contact/etc.)
  useEffect(() => {
    if (!sessionUser) return
    const controller = new AbortController()
    fetchFirmSettings(controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return
        const merged = { ...DEFAULT_FIRM_SETTINGS, ...settings }
        setFirmSettings(merged)
        setPublicFirmSettings({
          name: merged.name,
          tagline: merged.tagline ?? '',
          logoUrl: merged.logoUrl ?? '',
          brandColor: merged.brandColor || '#3c2044',
          sidebarTextColor: merged.sidebarTextColor || '#ffffff',
          sidebarActiveTextColor: merged.sidebarActiveTextColor || '#ffffff',
        })
      })
      .catch(() => {
        /* not fatal — keep defaults */
      })
    return () => controller.abort()
  }, [sessionUser])

  // Apply firm name to the browser tab title.
  useEffect(() => {
    document.title = publicFirmSettings.name || DEFAULT_FIRM_SETTINGS.name
  }, [publicFirmSettings.name])

  // Push the firm brand color into the --sidebar-bg CSS variable. It drives
  // ONLY the sidebar background — deliberately decoupled from --plum (which
  // stays a fixed dark accent used for page/section header TEXT on the light
  // pages). Coupling them meant a light brand color (e.g. pale blue) turned
  // every header into invisible light-on-white text.
  useEffect(() => {
    const color = publicFirmSettings.brandColor || '#3c2044'
    document.documentElement.style.setProperty('--sidebar-bg', color)
  }, [publicFirmSettings.brandColor])

  // Sidebar text color — kept as a separate variable so any brand color
  // can still have legible text on top of it. Defaults to white so the
  // existing styles (designed for a plum background) keep working when
  // no value is set.
  useEffect(() => {
    const color = publicFirmSettings.sidebarTextColor || '#ffffff'
    document.documentElement.style.setProperty('--sidebar-text', color)
  }, [publicFirmSettings.sidebarTextColor])

  // Active sidebar nav-item color — distinct from the regular sidebar
  // text color so the currently-open page can stand out from the rest.
  // Defaults to white so unconfigured workspaces look the same as
  // before.
  useEffect(() => {
    const color = publicFirmSettings.sidebarActiveTextColor || '#ffffff'
    document.documentElement.style.setProperty('--sidebar-active-text', color)
  }, [publicFirmSettings.sidebarActiveTextColor])

  // Invoice printing: the report-print CSS keeps the whole app shell visible,
  // which would otherwise leak the entire Invoices screen (billing queue +
  // every client) into the printout next to the formatted invoice sheet. Tag
  // <body> while an invoice print is in flight so the invoice-only print rules
  // (hide app shell, show just .print-document) win by specificity. Detecting
  // the mounted .print-sheet means this also covers a plain Ctrl+P on the
  // Invoices page, while Reports/Productivity printing is left untouched.
  useEffect(() => {
    const onBeforePrint = () => {
      if (document.querySelector('.print-document .print-sheet')) {
        document.body.classList.add('printing-invoice')
      }
    }
    const onAfterPrint = () => {
      document.body.classList.remove('printing-invoice')
    }
    window.addEventListener('beforeprint', onBeforePrint)
    window.addEventListener('afterprint', onAfterPrint)
    return () => {
      window.removeEventListener('beforeprint', onBeforePrint)
      window.removeEventListener('afterprint', onAfterPrint)
    }
  }, [])

  // Load app data on session change AND whenever preview state changes.
  // Entering preview refetches with `?previewAs=<id>` so the whole app
  // reflects the previewed person's scoped dataset; exiting refetches as the
  // owner. The owner-only guard for `previewAs` lives server-side.
  useEffect(() => {
    if (!sessionUser) {
      return
    }

    const controller = new AbortController()
    // Owners are the only ones who can preview; for everyone else the param
    // is omitted (and would be ignored server-side anyway).
    const previewAs =
      previewUserId && sessionUser.role === 'owner' ? previewUserId : null

    const load = async () => {
      try {
        setDataSyncState('loading')
        const remoteData = ensureRecurringChecklists(
          await fetchAppData(controller.signal, previewAs),
        ).data
        skipAutosaveRef.current += 1
        setData(remoteData)
        setServerPersistenceEnabled(true)
        setDataSyncState('synced')
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        if (error instanceof ApiError && error.status === 401) {
          setSessionUser(null)
          setServerPersistenceEnabled(false)
          setDataSyncState('offline')
          return
        }

        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
      }
    }

    void load()

    return () => controller.abort()
  }, [sessionUser, previewUserId])

  useEffect(() => {
    if (!serverPersistenceEnabled) {
      return
    }

    // Preview mode is strictly read-only — never autosave the previewed
    // person's scoped dataset back over the real workspace.
    if (previewUserId && sessionUser?.role === 'owner') {
      return
    }

    // If a local-only mutator flagged this save as mandatory (e.g. a
    // `deleteClient` whose only persistence path is autosave), honor it
    // — drain the skip counter so we don't double-skip later, and fall
    // through to the persist branch below. Otherwise, the skip counter
    // is the normal "post-fetch echo / API-mirror" guard.
    if (forceNextSaveRef.current) {
      forceNextSaveRef.current = false
      skipAutosaveRef.current = 0
    } else if (skipAutosaveRef.current > 0) {
      skipAutosaveRef.current -= 1
      setDataSyncState('synced')
      return
    }

    const timeoutId = window.setTimeout(() => {
      const persist = async () => {
        try {
          setDataSyncState('saving')
          await saveAppData(data)
          setDataSyncState('synced')
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            setSessionUser(null)
            setServerPersistenceEnabled(false)
            return
          }

          setDataSyncState('error')
        }
      }

      void persist()
    }, 250)

    return () => window.clearTimeout(timeoutId)
  }, [data, serverPersistenceEnabled, previewUserId, sessionUser])

  useEffect(() => {
    if (!timer) {
      return
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [timer])

  const visibleChecklists = useMemo(() => {
    if (role === 'owner') {
      return sortChecklists(data.checklists)
    }

    return sortChecklists(
      data.checklists.filter(
        (checklist) =>
          checklist.assigneeId === activeEmployeeId ||
          (checklist.viewerIds ?? []).includes(activeEmployeeId),
      ),
    )
  }, [activeEmployeeId, data.checklists, role])

  const visibleClientIds = useMemo(() => {
    if (role === 'owner') {
      return new Set(data.clients.map((client) => client.id))
    }

    return new Set([
      ...data.clients
        .filter((client) => getAssignedEmployeeIds(client).includes(activeEmployeeId))
        .map((client) => client.id),
      ...data.checklists
        .filter((checklist) => checklist.assigneeId === activeEmployeeId)
        .map((checklist) => checklist.clientId),
      ...data.timeEntries
        .filter((entry) => entry.employeeId === activeEmployeeId)
        .map((entry) => entry.clientId),
    ])
  }, [activeEmployeeId, data.checklists, data.clients, data.timeEntries, role])

  const visibleClients = useMemo(
    () => data.clients.filter((client) => visibleClientIds.has(client.id)),
    [data.clients, visibleClientIds],
  )

  const visibleEntries = useMemo(() => {
    if (role === 'owner') {
      return data.timeEntries
    }

    return data.timeEntries.filter((entry) => entry.employeeId === activeEmployeeId)
  }, [activeEmployeeId, data.timeEntries, role])

  const updateWorkspaceData = (updater: (current: AppData) => AppData) => {
    // This mutator path is local-only — there's no companion API call to
    // persist the change. The autosave is the ONLY way it reaches the
    // server, so flag the next autosave as mandatory regardless of any
    // pending skip-counter increments from concurrent API mutations.
    forceNextSaveRef.current = true
    // Mark the moment of this edit so a real-time refetch (SSE) defers rather
    // than overwriting an in-flight, not-yet-saved change.
    lastWorkspaceEditRef.current = new Date().getTime()
    // Preview mode is strictly read-only: every workspace-config mutator
    // (templates, clients, plans, stages) routes through here, so a single
    // early-return neutralizes all of them at once.
    if (previewActiveRef.current) {
      return
    }
    setData((current) => ensureRecurringChecklists(updater(current)).data)
  }

  const applyServerDataUpdate = (updater: (current: AppData) => AppData) => {
    skipAutosaveRef.current += 1
    setData(updater)
  }

  const logTime = async (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const newEntry = await createTimeEntry(entry)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: [newEntry, ...current.timeEntries],
      }))
      setSelectedClientId(newEntry.clientId)
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
      throw error
    }
  }

  // Split an unsplit group holding entry across its member clients: create one
  // billable entry per client (sharing a fresh group id), then delete the
  // holding entry — replacing it. Reuses the same validated create endpoint.
  const splitGroupEntry = async (
    holding: TimeEntry,
    mode: GroupAllocationMode,
    customMinutes: Record<string, number>,
  ) => {
    if (previewActiveRef.current) return
    const memberIds = Array.isArray(holding.groupClientIds) ? holding.groupClientIds : []
    const allocation = allocateGroupMinutes(holding.minutes, memberIds, mode, customMinutes)
    const allocated = memberIds
      .map((id) => ({ id, minutes: allocation[id] ?? 0 }))
      .filter((row) => row.minutes > 0)
    if (allocated.length === 0) {
      throw new Error('Nothing to allocate')
    }
    const groupId = makeId('grp')
    const isManual = holding.entryMethod === 'manual'
    try {
      setDataSyncState('saving')
      const created: TimeEntry[] = []
      for (const row of allocated) {
        created.push(
          await createTimeEntry({
            employeeId: holding.employeeId,
            clientId: row.id,
            isAdministrative: false,
            date: holding.date,
            minutes: row.minutes,
            description: holding.description,
            billable: true,
            taskId: null,
            entryMethod: holding.entryMethod === 'manual' ? 'manual' : 'timer',
            manualReason: isManual
              ? holding.manualReason || 'Split from group time'
              : undefined,
            groupId,
          }),
        )
      }
      await deleteTimeEntryRequest(holding.id)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: [
          ...created,
          ...current.timeEntries.filter((entry) => entry.id !== holding.id),
        ],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const stopTimer = async (descriptionOverride?: string) => {
    if (previewActiveRef.current || !timer) {
      return
    }

    const isAdministrative = Boolean(timer.isAdministrative)
    // Use the latest edited description (the timer panel lets users keep
    // editing "what did you do?" while the timer runs). Fall back to the
    // description captured at start if the field was cleared.
    const description =
      descriptionOverride && descriptionOverride.trim()
        ? descriptionOverride
        : timer.description
    // Audit timestamps: the timer knows exactly when it started and stopped.
    const stoppedAtMs = new Date().getTime()
    const session = {
      startAt: new Date(timer.startedAt).toISOString(),
      endAt: new Date(stoppedAtMs).toISOString(),
    }

    // Resuming an existing pending entry: append this session to it (the
    // server recomputes the total + envelope and keeps it pending) instead of
    // creating a brand-new entry.
    if (timer.resumeEntryId) {
      const existing = data.timeEntries.find((entry) => entry.id === timer.resumeEntryId)
      if (existing) {
        const prior =
          existing.sessions && existing.sessions.length > 0
            ? existing.sessions
            : existing.startAt && existing.endAt
              ? [{ startAt: existing.startAt, endAt: existing.endAt }]
              : []
        await updateTimeEntry(existing.id, { sessions: [...prior, session] })
        setTimer(null)
        return
      }
      // The entry vanished (deleted) — fall through to log a fresh one.
    }

    // Group timing: save ONE unsplit holding entry (no single client, not
    // billable) carrying the member clients. The owner splits it across them
    // for billing later, which replaces it with one billable entry per client.
    const groupClientIds = Array.isArray(timer.groupClientIds) ? timer.groupClientIds : []
    if (groupClientIds.length > 0) {
      await logTime({
        employeeId: timer.employeeId,
        clientId: '',
        isAdministrative: false,
        groupClientIds,
        date: new Date(timer.startedAt).toISOString().slice(0, 10),
        minutes: Math.max(1, Math.round((stoppedAtMs - timer.startedAt) / 60000)),
        description,
        startAt: session.startAt,
        endAt: session.endAt,
        sessions: [session],
        // Not billable until split; no single client or task.
        billable: false,
        taskId: null,
        entryMethod: 'timer',
      })
      setTimer(null)
      return
    }

    await logTime({
      employeeId: timer.employeeId,
      clientId: timer.clientId,
      isAdministrative,
      date: new Date(timer.startedAt).toISOString().slice(0, 10),
      minutes: Math.max(1, Math.round((stoppedAtMs - timer.startedAt) / 60000)),
      description,
      startAt: session.startAt,
      endAt: session.endAt,
      sessions: [session],
      // Administrative time is never billable; the server enforces this too.
      billable: !isAdministrative,
      taskId: timer.taskId ?? null,
      entryMethod: 'timer',
    })
    setTimer(null)
  }

  const updateTimeEntry = async (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      taskId?: string | null
      date?: string
      startAt?: string
      endAt?: string
      sessions?: { startAt: string; endAt: string }[]
      employeeId?: string
    },
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await updateTimeEntryRequest(entryId, patch)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: current.timeEntries.map((entry) =>
          entry.id === entryId ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const deleteTimeEntry = async (entryId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await deleteTimeEntryRequest(entryId)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: current.timeEntries.filter((entry) => entry.id !== entryId),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const approveTimeEntry = async (entryId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await approveTimeEntryRequest(entryId)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: current.timeEntries.map((entry) =>
          entry.id === entryId ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const rejectTimeEntry = async (entryId: string, note: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await rejectTimeEntryRequest(entryId, note)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: current.timeEntries.map((entry) =>
          entry.id === entryId ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const approveTimeEntriesBatch = async (entryIds: string[]) => {
    if (previewActiveRef.current || entryIds.length === 0) return
    try {
      setDataSyncState('saving')
      await approveTimeEntriesBatchRequest(entryIds)
      // Re-fetch is heavy; apply optimistic local approval instead.
      const ids = new Set(entryIds)
      const stamp = new Date().toISOString()
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: current.timeEntries.map((entry) =>
          ids.has(entry.id)
            ? {
                ...entry,
                approvalStatus: 'approved' as const,
                approvedBy: sessionUser?.id,
                approvedAt: stamp,
                approvalNote: undefined,
              }
            : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const lockTimesheet = async (userId: string, period: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const result = await lockTimesheetRequest(userId, period)
      const stamp = new Date().toISOString()
      applyServerDataUpdate((current) => {
        const withoutDup = (current.timesheetLocks ?? []).filter(
          (lock) => !(lock.userId === userId && lock.period === period),
        )
        const lock = result.lock ?? {
          id: `lock-${userId}-${period}`,
          userId,
          period,
          lockedBy: sessionUser?.id ?? '',
          lockedAt: stamp,
        }
        return {
          ...current,
          timesheetLocks: [...withoutDup, lock],
          // Locking auto-approves that user's pending entries for the period.
          timeEntries: current.timeEntries.map((entry) =>
            entry.employeeId === userId &&
            entry.approvalStatus === 'pending' &&
            entry.date.slice(0, 7) === period
              ? {
                  ...entry,
                  approvalStatus: 'approved' as const,
                  approvedBy: sessionUser?.id,
                  approvedAt: stamp,
                }
              : entry,
          ),
        }
      })
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const unlockTimesheet = async (userId: string, period: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await unlockTimesheetRequest(userId, period)
      applyServerDataUpdate((current) => ({
        ...current,
        timesheetLocks: (current.timesheetLocks ?? []).filter(
          (lock) => !(lock.userId === userId && lock.period === period),
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /**
   * Submit the caller's own Sun-Sat week for owner review. The server keys
   * off `session.user.id`, so this handler only needs the week-start
   * date. The returned submission row is either upserted into
   * `data.weeklySubmissions` (re-submit on the same week reuses the row id)
   * or appended for a brand-new week.
   */
  const submitWeeklyTimesheet = async (weekStart: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const submission = await submitWeeklyTimesheetRequest(weekStart)
      applyServerDataUpdate((current) => {
        const list = current.weeklySubmissions ?? []
        const existsAt = list.findIndex((entry) => entry.id === submission.id)
        const next =
          existsAt >= 0
            ? list.map((entry, index) => (index === existsAt ? submission : entry))
            : [submission, ...list]
        return { ...current, weeklySubmissions: next }
      })
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /**
   * Owner approves a weekly submission. Mirrors the server's two-part
   * transaction locally: the submission flips to 'approved' AND every
   * pending time entry in that user's Sun-Sat week becomes 'approved'
   * (with the calling owner as approver) so the per-entry approval queue
   * empties in the same render as the weekly sign-off.
   */
  const approveWeeklySubmission = async (submissionId: string) => {
    if (previewActiveRef.current) return
    const reviewerId = sessionUser?.id
    if (!reviewerId) return
    try {
      setDataSyncState('saving')
      const updated = await approveWeeklySubmissionRequest(submissionId)
      const reviewedAt = updated.reviewedAt ?? new Date().toISOString()
      const weekStartDate = new Date(`${updated.weekStart}T12:00:00`)
      const weekEndDate = new Date(weekStartDate)
      weekEndDate.setDate(weekEndDate.getDate() + 7)
      const weekEnd = weekEndDate.toISOString().slice(0, 10)

      applyServerDataUpdate((current) => ({
        ...current,
        weeklySubmissions: (current.weeklySubmissions ?? []).map((entry) =>
          entry.id === submissionId ? updated : entry,
        ),
        timeEntries: current.timeEntries.map((entry) => {
          if (
            entry.employeeId === updated.userId &&
            entry.approvalStatus === 'pending' &&
            entry.date >= updated.weekStart &&
            entry.date < weekEnd
          ) {
            return {
              ...entry,
              approvalStatus: 'approved',
              approvedBy: reviewerId,
              approvedAt: reviewedAt,
            }
          }
          return entry
        }),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /**
   * Owner rejects a weekly submission with a note. The submission row
   * stays in `data.weeklySubmissions` with status='rejected' (so the
   * submitter sees the rationale on their time page) — no time-entry
   * mutations on this path, since the bookkeeper still owns those rows
   * and may edit / resubmit.
   */
  /**
   * Owner-only: add a reimbursement to a client. Pushes the new record
   * onto `data.reimbursements` so the InvoicesPage + ClientDetailPage
   * pick it up without a refetch.
   */
  const addReimbursement = async (input: {
    clientId: string
    date: string
    description: string
    amount: number
  }) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const created = await addReimbursementRequest(input)
      applyServerDataUpdate((current) => ({
        ...current,
        reimbursements: [created, ...(current.reimbursements ?? [])],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /** Owner-only: patch a reimbursement (date / description / amount). */
  const updateReimbursement = async (
    id: string,
    patch: { date?: string; description?: string; amount?: number },
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await updateReimbursementRequest(id, patch)
      applyServerDataUpdate((current) => ({
        ...current,
        reimbursements: (current.reimbursements ?? []).map((entry) =>
          entry.id === id ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /**
   * Owner-only: add a recurring reimbursement to a client. Same local
   * mirror pattern as the one-off — push onto `data.recurringReimbursements`
   * so getInvoice picks it up everywhere without a refetch.
   */
  const addRecurringReimbursement = async (input: {
    clientId: string
    description: string
    amount: number
    frequency: 'monthly' | 'quarterly' | 'annually'
    startDate: string
  }) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const created = await addRecurringReimbursementRequest(input)
      applyServerDataUpdate((current) => ({
        ...current,
        recurringReimbursements: [created, ...(current.recurringReimbursements ?? [])],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /** Owner-only: patch a recurring reimbursement. */
  const updateRecurringReimbursement = async (
    id: string,
    patch: {
      description?: string
      amount?: number
      frequency?: 'monthly' | 'quarterly' | 'annually'
      startDate?: string
    },
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await updateRecurringReimbursementRequest(id, patch)
      applyServerDataUpdate((current) => ({
        ...current,
        recurringReimbursements: (current.recurringReimbursements ?? []).map((entry) =>
          entry.id === id ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /** Owner-only: stop a recurring reimbursement by removing it. */
  const deleteRecurringReimbursement = async (id: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await deleteRecurringReimbursementRequest(id)
      applyServerDataUpdate((current) => ({
        ...current,
        recurringReimbursements: (current.recurringReimbursements ?? []).filter(
          (entry) => entry.id !== id,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  /** Owner-only: remove a reimbursement. */
  const deleteReimbursement = async (id: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await deleteReimbursementRequest(id)
      applyServerDataUpdate((current) => ({
        ...current,
        reimbursements: (current.reimbursements ?? []).filter((entry) => entry.id !== id),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const rejectWeeklySubmission = async (submissionId: string, note: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await rejectWeeklySubmissionRequest(submissionId, note)
      applyServerDataUpdate((current) => ({
        ...current,
        weeklySubmissions: (current.weeklySubmissions ?? []).map((entry) =>
          entry.id === submissionId ? updated : entry,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const toggleChecklistItem = async (checklistId: string, itemId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await toggleChecklistItemRequest(checklistId, itemId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
    }
  }

  // Sub-item mutations on live checklists go through dedicated endpoints
  // (consistent with the other live-checklist item endpoints) and merge the
  // server-confirmed checklist back in. Each early-returns in preview mode.
  const toggleSubItem = async (checklistId: string, itemId: string, subItemId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await toggleChecklistItemRequest(checklistId, itemId, subItemId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const addSubItem = async (checklistId: string, itemId: string, title: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await addChecklistSubItemRequest(checklistId, itemId, title)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const removeSubItem = async (checklistId: string, itemId: string, subItemId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await removeChecklistSubItemRequest(checklistId, itemId, subItemId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  // Sub-sub-item mutations on live checklists — the deepest level. Same dedicated
  // endpoints / server-confirmed merge as sub-items, just one level deeper.
  // Each early-returns in preview mode.
  const toggleSubSubItem = async (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await toggleChecklistItemRequest(
        checklistId,
        itemId,
        subItemId,
        subSubItemId,
      )
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const addSubSubItem = async (
    checklistId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await addChecklistSubSubItemRequest(
        checklistId,
        itemId,
        subItemId,
        title,
      )
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const removeSubSubItem = async (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updatedChecklist = await removeChecklistSubSubItemRequest(
        checklistId,
        itemId,
        subItemId,
        subSubItemId,
      )
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const setChecklistViewers = async (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await setChecklistViewersRequest(checklistId, viewerIds, editorIds)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? { ...checklist, ...updated } : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
    }
  }

  const setTemplateViewers = async (
    templateId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await setTemplateViewersRequest(templateId, viewerIds, editorIds)
      applyServerDataUpdate((current) => ({
        ...current,
        checklistTemplates: current.checklistTemplates.map((template) =>
          template.id === templateId ? { ...template, ...updated } : template,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
    }
  }

  const addChecklistTemplate = (template: Omit<ChecklistTemplate, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: [
        ...current.checklistTemplates,
        { ...template, id: makeId('template') },
      ],
    }))
  }

  const updateChecklistTemplate = (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: current.checklistTemplates.map((template) =>
        template.id === templateId ? updater(template) : template,
      ),
    }))
  }

  const deleteChecklistTemplate = (templateId: string) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: current.checklistTemplates.filter(
        (template) => template.id !== templateId,
      ),
    }))
  }

  // Edit an ACTIVE (materialized) checklist's own fields — title, concrete due
  // date, assignee. Item-level edits keep their dedicated endpoints; these
  // checklist-level fields ride the bulk autosave like other workspace edits.
  const updateChecklist = (
    checklistId: string,
    patch: { title?: string; dueDate?: string; assigneeId?: string },
  ) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklists: current.checklists.map((checklist) =>
        checklist.id === checklistId ? { ...checklist, ...patch } : checklist,
      ),
    }))
  }

  // Phase 3: stage-aware mutators. Each mutator targets a specific stage by id;
  // the legacy single-list handlers are gone. Forward-only: items can move
  // across stages via remove/add, but there's no send-back chain.
  const mutateStage = (
    templateId: string,
    stageId: string,
    updater: (stage: ChecklistTemplate['stages'][number]) => ChecklistTemplate['stages'][number],
  ) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      stages: (template.stages ?? []).map((stage) => (stage.id === stageId ? updater(stage) : stage)),
    }))
  }

  const addChecklistTemplateItem = (templateId: string, stageId: string) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: [...stage.items, { id: makeId('template-item'), label: 'New checklist item' }],
    }))
  }

  const updateChecklistTemplateItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    label: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) => (item.id === itemId ? { ...item, label } : item)),
    }))
  }

  const removeChecklistTemplateItem = (templateId: string, stageId: string, itemId: string) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.filter((item) => item.id !== itemId),
    }))
  }

  // Template-item sub-items. Edited through the template-save path (like every
  // other template-item edit), so they go via mutateStage / updateWorkspaceData
  // — which already early-returns in preview mode.
  const addChecklistTemplateSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    title: string,
  ) => {
    const trimmed = title.trim()
    if (!trimmed) return
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: [
                ...(item.subItems ?? []),
                { id: makeId('subitem'), title: trimmed },
              ],
            }
          : item,
      ),
    }))
  }

  const updateChecklistTemplateSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: (item.subItems ?? []).map((sub) =>
                sub.id === subItemId ? { ...sub, title } : sub,
              ),
            }
          : item,
      ),
    }))
  }

  const removeChecklistTemplateSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: (item.subItems ?? []).filter((sub) => sub.id !== subItemId),
            }
          : item,
      ),
    }))
  }

  // Template sub-sub-items — the deepest template level. Edited through the
  // same template-save path as every other template-item edit (mutateStage),
  // which already early-returns in preview mode.
  const addChecklistTemplateSubSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => {
    const trimmed = title.trim()
    if (!trimmed) return
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: (item.subItems ?? []).map((sub) =>
                sub.id === subItemId
                  ? {
                      ...sub,
                      subItems: [
                        ...(sub.subItems ?? []),
                        { id: makeId('subsubitem'), title: trimmed },
                      ],
                    }
                  : sub,
              ),
            }
          : item,
      ),
    }))
  }

  const updateChecklistTemplateSubSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
    title: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: (item.subItems ?? []).map((sub) =>
                sub.id === subItemId
                  ? {
                      ...sub,
                      subItems: (sub.subItems ?? []).map((subSub) =>
                        subSub.id === subSubItemId ? { ...subSub, title } : subSub,
                      ),
                    }
                  : sub,
              ),
            }
          : item,
      ),
    }))
  }

  const removeChecklistTemplateSubSubItem = (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              subItems: (item.subItems ?? []).map((sub) =>
                sub.id === subItemId
                  ? {
                      ...sub,
                      subItems: (sub.subItems ?? []).filter(
                        (subSub) => subSub.id !== subSubItemId,
                      ),
                    }
                  : sub,
              ),
            }
          : item,
      ),
    }))
  }

  const setChecklistTemplateItemDueDate = (
    templateId: string,
    stageId: string,
    itemId: string,
    dueDate: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) => {
        if (item.id !== itemId) return item
        const next = { ...item }
        if (!dueDate) delete next.dueDate
        else next.dueDate = dueDate
        return next
      }),
    }))
  }

  const setChecklistTemplateItemAssignee = (
    templateId: string,
    stageId: string,
    itemId: string,
    assigneeId: string,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: stage.items.map((item) => {
        if (item.id !== itemId) return item
        const next = { ...item }
        if (!assigneeId) delete next.assigneeId
        else next.assigneeId = assigneeId
        return next
      }),
    }))
  }

  const reorderChecklistTemplateItems = (
    templateId: string,
    stageId: string,
    orderedIds: string[],
  ) => {
    mutateStage(templateId, stageId, (stage) => {
      const byId = new Map(stage.items.map((item) => [item.id, item]))
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((item): item is (typeof stage.items)[number] => Boolean(item))
      const seen = new Set(orderedIds)
      const tail = stage.items.filter((item) => !seen.has(item.id))
      return { ...stage, items: [...next, ...tail] }
    })
  }

  const bulkAddChecklistTemplateItems = (
    templateId: string,
    stageId: string,
    labels: string[],
  ) => {
    if (labels.length === 0) return
    mutateStage(templateId, stageId, (stage) => ({
      ...stage,
      items: [
        ...stage.items,
        ...labels.map((label) => ({ id: makeId('template-item'), label })),
      ],
    }))
  }

  const addTemplateStage = (templateId: string) => {
    updateChecklistTemplate(templateId, (template) => {
      const existing = template.stages ?? []
      const defaultAssignee = existing[existing.length - 1]?.assigneeId || template.assigneeId
      return {
        ...template,
        stages: [
          ...existing,
          {
            id: makeId('stage'),
            name: `Stage ${existing.length + 1}`,
            assigneeId: defaultAssignee,
            offsetDays: 0,
            viewerIds: [],
            editorIds: [],
            items: [],
          },
        ],
      }
    })
  }

  const removeTemplateStage = (templateId: string, stageId: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      stages: (template.stages ?? []).filter((stage) => stage.id !== stageId),
    }))
  }

  const patchTemplateStage = (
    templateId: string,
    stageId: string,
    patch: Partial<ChecklistTemplate['stages'][number]>,
  ) => {
    mutateStage(templateId, stageId, (stage) => ({ ...stage, ...patch }))
  }

  const reorderTemplateStages = (templateId: string, orderedStageIds: string[]) => {
    updateChecklistTemplate(templateId, (template) => {
      const byId = new Map((template.stages ?? []).map((stage) => [stage.id, stage]))
      const reordered = orderedStageIds
        .map((id) => byId.get(id))
        .filter((stage): stage is ChecklistTemplate['stages'][number] => Boolean(stage))
      const seen = new Set(orderedStageIds)
      const tail = (template.stages ?? []).filter((stage) => !seen.has(stage.id))
      return { ...template, stages: [...reordered, ...tail] }
    })
  }

  const reorderChecklistItems = async (checklistId: string, orderedIds: string[]) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await reorderChecklistItemsRequest(checklistId, orderedIds)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updated : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const bulkAddChecklistItems = async (checklistId: string, labels: string[]) => {
    if (previewActiveRef.current || labels.length === 0) return
    try {
      setDataSyncState('saving')
      const updated = await appendChecklistItemsRequest(checklistId, labels)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updated : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const createChecklist = async (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    /** Items may carry a nested `subItems` tree built in the outliner. */
    items: Array<Pick<ChecklistTemplateItem, 'label' | 'subItems'>>
  }) => {
    if (previewActiveRef.current) return null
    try {
      setDataSyncState('saving')
      const created = await createChecklistRequest(payload)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: [...current.checklists, created],
      }))
      setDataSyncState('synced')
      return created
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return null
      }
      setDataSyncState('error')
      throw error
    }
  }

  const updateChecklistItem = async (
    checklistId: string,
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null; waitingOn?: string | null },
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await updateChecklistItemRequest(checklistId, itemId, patch)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updated : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  const deleteChecklistItem = async (checklistId: string, itemId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const updated = await deleteChecklistItemRequest(checklistId, itemId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updated : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  /**
   * Owner-only soft delete. The server stamps `deleted_at` on the row and
   * `read()` sorts it into `recycledChecklists`; locally we mirror that by
   * moving the checklist from the active list to the bin (with a deletedAt
   * timestamp) so the UI updates without a refetch. Time entries that
   * reference the checklist's items via `taskId` are preserved on the
   * server so billing history survives. Preview mode is blocked the same
   * way the rest of the write surface is, and 401s flip to offline.
   */
  const deleteChecklist = async (checklistId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await deleteChecklistRequest(checklistId)
      const deletedAt = new Date().toISOString()
      applyServerDataUpdate((current) => {
        const target = current.checklists.find((checklist) => checklist.id === checklistId)
        if (!target) return current
        return {
          ...current,
          checklists: current.checklists.filter((checklist) => checklist.id !== checklistId),
          recycledChecklists: [
            { ...target, deletedAt },
            ...(current.recycledChecklists ?? []),
          ],
        }
      })
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  /**
   * Owner-only restore from the recycle bin. The server clears `deleted_at`
   * and returns the freshly-active Checklist; we drop it back into the
   * active list and remove it from the bin in one local update.
   */
  const restoreChecklist = async (checklistId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const restored = await restoreChecklistRequest(checklistId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: [...current.checklists, restored],
        recycledChecklists: (current.recycledChecklists ?? []).filter(
          (checklist) => checklist.id !== checklistId,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  /**
   * Owner-only "empty the bin" — permanently deletes every recycled checklist
   * server-side (the `checklist_items` FK cascade cleans up linked items).
   * Locally we just clear the array; time entries are untouched.
   */
  const emptyChecklistRecycleBin = async () => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      await emptyChecklistRecycleBinRequest()
      applyServerDataUpdate((current) => ({
        ...current,
        recycledChecklists: [],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
    }
  }

  /**
   * Soft-delete a team member. The server stamps `inactive_at` on their
   * user row (so historical attribution on time entries / completed
   * checklists survives), reassigns FK-blocking ACTIVE work to the
   * calling owner, strips them from viewer / editor / assigned-team
   * arrays, and revokes their sessions. We mirror locally so the UI
   * reflects the change instantly:
   *  - Move them from `employees` to `inactiveEmployees` (with
   *    `inactiveAt` set) — analytics' "include former team" toggle
   *    surfaces them from there.
   *  - Reassign assignees on ACTIVE checklists / templates / stages
   *    (matching the server's `where deleted_at is null` scope; the
   *    recycle bin keeps its original assignee for the audit trail).
   *  - Strip permission arrays.
   *  - LEAVE time entries and timesheet locks alone — they're history.
   *
   * Preview mode is blocked the same way the rest of the write surface is.
   */
  const deleteTeamMember = async (userId: string) => {
    if (previewActiveRef.current) return
    const ownerId = sessionUser?.id
    if (!ownerId) return
    try {
      setDataSyncState('saving')
      await deleteTeamMemberRequest(userId)
      const inactiveAt = new Date().toISOString()

      const stripArrayId = (arr: string[] | undefined) =>
        Array.isArray(arr) ? arr.filter((id) => id !== userId) : (arr ?? [])

      applyServerDataUpdate((current) => {
        // Items use optional `assigneeId?: string`, so "unassign" is a field
        // omit (not `null`) — copy then delete so the shape matches the type
        // contract without leaving the field present-but-undefined.
        const clearAssignee = <T extends { assigneeId?: string | null }>(item: T): T => {
          const next = { ...item }
          delete next.assigneeId
          return next
        }

        const reassignActiveChecklist = (checklist: AppData['checklists'][number]) => ({
          ...checklist,
          assigneeId:
            checklist.assigneeId === userId ? ownerId : checklist.assigneeId,
          viewerIds: stripArrayId(checklist.viewerIds),
          editorIds: stripArrayId(checklist.editorIds),
          items: Array.isArray(checklist.items)
            ? checklist.items.map((item) =>
                item && item.assigneeId === userId ? clearAssignee(item) : item,
              )
            : checklist.items,
        })

        const removed = current.employees.find((employee) => employee.id === userId)
        const remainingEmployees = current.employees.filter((employee) => employee.id !== userId)
        const nextInactive = removed
          ? [{ ...removed, inactiveAt }, ...(current.inactiveEmployees ?? [])]
          : (current.inactiveEmployees ?? [])

        return {
          ...current,
          // Active checklists get reassigned; recycled ones keep their
          // original assignee (now pointing at an inactive user, which
          // is fine because the user row still exists for lookups).
          checklists: current.checklists.map(reassignActiveChecklist),
          checklistTemplates: current.checklistTemplates.map((template) => ({
            ...template,
            assigneeId:
              template.assigneeId === userId ? ownerId : template.assigneeId,
            viewerIds: stripArrayId(template.viewerIds),
            editorIds: stripArrayId(template.editorIds),
            items: Array.isArray(template.items)
              ? template.items.map((item) =>
                  item && item.assigneeId === userId ? clearAssignee(item) : item,
                )
              : template.items,
            stages: Array.isArray(template.stages)
              ? template.stages.map((stage) => ({
                  ...stage,
                  assigneeId:
                    stage.assigneeId === userId ? ownerId : stage.assigneeId,
                  viewerIds: stripArrayId(stage.viewerIds),
                  editorIds: stripArrayId(stage.editorIds),
                }))
              : template.stages,
          })),
          clients: current.clients.map((client) => ({
            ...client,
            assignedBookkeeperIds: stripArrayId(client.assignedBookkeeperIds),
            assignedEmployeeIds: stripArrayId(client.assignedEmployeeIds),
          })),
          // Time entries + timesheet locks intentionally untouched so
          // analytics can still attribute the work / sign-offs.
          employees: remainingEmployees,
          inactiveEmployees: nextInactive,
        }
      })
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const duplicateChecklistTemplate = (templateId: string) => {
    updateWorkspaceData((current) => {
      const source = current.checklistTemplates.find((template) => template.id === templateId)
      if (!source) {
        return current
      }

      const draft: ChecklistTemplate = {
        ...source,
        id: makeId('template'),
        title: `${source.title} (copy)`,
        viewerIds: [...(source.viewerIds ?? [])],
        editorIds: [...(source.editorIds ?? [])],
        stages: (source.stages ?? []).map((stage) => ({
          ...stage,
          id: makeId('stage'),
          viewerIds: [...(stage.viewerIds ?? [])],
          editorIds: [...(stage.editorIds ?? [])],
          items: stage.items.map((item) => ({ id: makeId('template-item'), label: item.label })),
        })),
      }

      return {
        ...current,
        checklistTemplates: [...current.checklistTemplates, draft],
      }
    })
  }

  // Wave 2: standard templates + apply/copy + on-demand generate. These hit
  // dedicated owner-only endpoints (not PUT /api/app-data) and merge the
  // server-confirmed result back in via applyServerDataUpdate.
  const createStandardTemplate = async (
    payload: Omit<ChecklistTemplate, 'id' | 'clientId' | 'isStandard'>,
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const created = await createStandardTemplateRequest(payload)
      applyServerDataUpdate((current) => ({
        ...current,
        checklistTemplates: [...current.checklistTemplates, created],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const applyTemplateToClient = async (
    templateId: string,
    payload: { clientId: string; firstDueDate?: string; frequency?: string },
  ) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const created = await applyTemplateToClientRequest(templateId, payload)
      applyServerDataUpdate((current) => ({
        ...current,
        checklistTemplates: [...current.checklistTemplates, created],
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const generateChecklistFromTemplate = async (
    templateId: string,
    payload: { dueDate?: string } = {},
  ) => {
    if (previewActiveRef.current) return null
    try {
      setDataSyncState('saving')
      const created = await generateChecklistFromTemplateRequest(templateId, payload)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: [...current.checklists, created],
      }))
      setDataSyncState('synced')
      return created
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return null
      }
      setDataSyncState('error')
      throw error
    }
  }

  const updateClientPlan = (clientId: string, billingMode: BillingMode, planId: string | null) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.map((client) =>
        client.id === clientId ? { ...client, billingMode, planId } : client,
      ),
    }))
  }

  const updateClient = (clientId: string, patch: Partial<Client>) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.map((client) =>
        client.id === clientId ? { ...client, ...patch } : client,
      ),
    }))
  }

  const deleteClient = (clientId: string) => {
    // Cascade the local cleanup so we don't leave orphan rows that reference a
    // client we just removed. Server-side these tables CASCADE on
    // `clients.id`, but the bulk autosave wipes-and-rewrites from local state,
    // so any orphan we keep around here would re-fail the FK on the next save.
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.filter((client) => client.id !== clientId),
      checklistTemplates: (current.checklistTemplates ?? []).filter(
        (template) => template.clientId !== clientId,
      ),
      checklists: (current.checklists ?? []).filter(
        (checklist) => checklist.clientId !== clientId,
      ),
      recycledChecklists: (current.recycledChecklists ?? []).filter(
        (checklist) => checklist.clientId !== clientId,
      ),
      reimbursements: (current.reimbursements ?? []).filter(
        (reimbursement) => reimbursement.clientId !== clientId,
      ),
      recurringReimbursements: (current.recurringReimbursements ?? []).filter(
        (recurring) => recurring.clientId !== clientId,
      ),
      timeEntries: (current.timeEntries ?? []).filter(
        (entry) => entry.clientId !== clientId,
      ),
    }))
  }

  const addClient = (client: Omit<Client, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: [{ ...client, id: makeId('client') }, ...current.clients],
    }))
  }

  const addPlan = (plan: Omit<SubscriptionPlan, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      plans: [{ ...plan, id: makeId('plan') }, ...current.plans],
    }))
  }

  // Patch a plan's editable fields (name / notes). Mirrors updateContact /
  // updateClient — a local workspace mutation persisted by the bulk autosave.
  const updatePlan = (planId: string, patch: Partial<SubscriptionPlan>) => {
    updateWorkspaceData((current) => ({
      ...current,
      plans: current.plans.map((plan) =>
        plan.id === planId ? { ...plan, ...patch } : plan,
      ),
    }))
  }

  // Contacts persist the SAME WAY plans/clients do — a local-only workspace
  // mutation that reaches the server via the bulk `/api/app-data` autosave
  // (saveAppData). No dedicated endpoint, matching addPlan/addClient.
  const addContact = (contact: Omit<Contact, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      contacts: [{ ...contact, id: makeId('contact') }, ...(current.contacts ?? [])],
    }))
  }

  const updateContact = (contactId: string, patch: Partial<Contact>) => {
    updateWorkspaceData((current) => ({
      ...current,
      contacts: (current.contacts ?? []).map((contact) =>
        contact.id === contactId ? { ...contact, ...patch } : contact,
      ),
    }))
  }

  const deleteContact = (contactId: string) => {
    updateWorkspaceData((current) => ({
      ...current,
      contacts: (current.contacts ?? []).filter((contact) => contact.id !== contactId),
      // Strip the deleted contact from every client so none reference a
      // missing contact id.
      clients: current.clients.map((client) =>
        Array.isArray(client.contactIds) && client.contactIds.includes(contactId)
          ? { ...client, contactIds: client.contactIds.filter((id) => id !== contactId) }
          : client,
      ),
    }))
  }

  /**
   * Owner-only: permanently delete a subscription plan. Server-side the
   * `clients.plan_id` FK cascades to null on delete, unlinking any clients
   * currently on the plan; we mirror that locally so the Clients page and
   * invoice calculations reflect the change instantly.
   */
  const deletePlan = async (planId: string) => {
    if (previewActiveRef.current) return
    try {
      setDataSyncState('saving')
      const result = await deletePlanRequest(planId)
      const unlinkedSet = new Set(result.unlinkedClientIds)
      applyServerDataUpdate((current) => ({
        ...current,
        plans: current.plans.filter((plan) => plan.id !== planId),
        clients: current.clients.map((client) =>
          unlinkedSet.has(client.id) ? { ...client, planId: null } : client,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }
      setDataSyncState('error')
      throw error
    }
  }

  const printInvoice = () => {
    // Tag the body up front so the invoice-only print rules apply even on
    // browsers that don't fire `beforeprint` (the listener above also sets
    // this for a plain Ctrl+P, and `afterprint` clears it). The class only
    // does anything inside @media print, so a lingering class can't affect
    // the on-screen layout.
    document.body.classList.add('printing-invoice')
    window.setTimeout(() => window.print(), 50)
  }

  const startTimer = (nextTimer: TimerState) => {
    if (previewActiveRef.current) return
    setNow(nextTimer.startedAt)
    setTimer(nextTimer)
  }

  const handleLogout = async () => {
    try {
      await logoutSession()
    } finally {
      setSessionUser(null)
      setServerPersistenceEnabled(false)
      setDataSyncState('loading')
      setTimer(null)
    }
  }

  const previewMode = previewActive
  const previewEmployee = previewMode
    ? data.employees.find((employee) => employee.id === previewUserId)
    : null
  const effectiveUser: SessionUser =
    previewMode && previewEmployee && sessionUser
      ? {
          id: previewEmployee.id,
          name: previewEmployee.name,
          email: sessionUser.email,
          role: 'employee',
          staffRole: previewEmployee.role,
        }
      : (sessionUser as SessionUser)
  // While previewing, the whole app must behave as the previewed person:
  // their role drives the sidebar, owner-only routing, and permission-gated
  // controls; their id drives the per-user data memos below. `sessionUser`
  // stays the real owner (account pill, 2FA banner, logout).
  const effectiveRole = effectiveUser?.role ?? 'employee'
  const ownerMode = effectiveRole === 'owner'
  const effectiveEmployeeId =
    previewMode && previewEmployee ? previewEmployee.id : activeEmployeeId

  // Strict "what clients can this user log time against?" — drives the
  // timer and manual-entry dropdowns on TimePage. A team member only ever
  // sees clients on their formal Assigned Team list (Client → Assigned
  // team UI, persisted to `assignedBookkeeperIds`). Owners outside preview
  // mode see every client, matching how owners view the rest of the app.
  // While an owner previews a bookkeeper `effectiveRole` is downgraded to
  // 'employee' and `effectiveEmployeeId` is the bookkeeper's id, so the
  // same rule naturally scopes the dropdown to the bookkeeper's view.
  const timeTrackingClients = useMemo(
    () =>
      effectiveRole === 'owner'
        ? data.clients
        : data.clients.filter((client) =>
            (client.assignedBookkeeperIds ?? []).includes(effectiveEmployeeId),
          ),
    [data.clients, effectiveRole, effectiveEmployeeId],
  )
  const syncMessage =
    dataSyncState === 'loading'
      ? 'Loading…'
      : dataSyncState === 'saving'
        ? 'Saving…'
        : dataSyncState === 'synced'
          ? 'All changes saved'
          : dataSyncState === 'error'
            ? 'Couldn’t save — retrying'
            : 'Offline — changes not saved'

  if (authState === 'loading') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyeline">{publicFirmSettings.name}</p>
          <h1>Loading…</h1>
        </section>
      </main>
    )
  }

  if (!sessionUser) {
    // Two role-segmented entry routes — bookkeepers land on /staff (the
    // default), the owner bookmarks /owner. Anything else routes to /staff
    // so the owner URL stays unadvertised. The two /two-factor* routes are
    // reachable without a session because they're gated by the
    // pbj_2fa_pending cookie set immediately before the redirect.
    return (
      <BrowserRouter>
        <Routes>
          <Route
            path="/sign-in"
            element={<SignInScreen firmSettings={publicFirmSettings} />}
          />
          {/* Legacy role-segmented URLs — kept for bookmarks but redirected
              to the unified sign-in page. The DB already knows each user's
              role, so the form doesn't need to ask which lane to use. */}
          <Route path="/owner" element={<Navigate to="/sign-in" replace />} />
          <Route path="/staff" element={<Navigate to="/sign-in" replace />} />
          <Route path="/two-factor" element={<TwoFactorPage />} />
          <Route path="/two-factor/setup" element={<TwoFactorSetupPage forced />} />
          <Route path="*" element={<Navigate to="/sign-in" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  const contextValue: AppContextValue = {
    data,
    sessionUser,
    effectiveUser,
    // `role`/`ownerMode`/`activeEmployeeId` are the EFFECTIVE values: while an
    // owner previews a bookkeeper they reflect the bookkeeper, so the sidebar,
    // routing, and permission-gated controls match what that person sees.
    role: effectiveRole,
    ownerMode,
    previewUserId,
    setPreviewUserId,
    previewMode,
    activeEmployeeId: effectiveEmployeeId,
    visibleChecklists,
    visibleClients,
    visibleClientIds,
    timeTrackingClients,
    visibleEntries,
    billingPeriod,
    setBillingPeriod,
    timer,
    timerElapsed: timer ? formatTimeFromMs(now - timer.startedAt) : '0:00',
    startTimer,
    stopTimer,
    logTime,
    splitGroupEntry,
    updateTimeEntry,
    deleteTimeEntry,
    approveTimeEntry,
    rejectTimeEntry,
    approveTimeEntriesBatch,
    lockTimesheet,
    unlockTimesheet,
    submitWeeklyTimesheet,
    approveWeeklySubmission,
    rejectWeeklySubmission,
    addReimbursement,
    updateReimbursement,
    deleteReimbursement,
    addRecurringReimbursement,
    updateRecurringReimbursement,
    deleteRecurringReimbursement,
    toggleChecklistItem,
    toggleSubItem,
    addSubItem,
    removeSubItem,
    toggleSubSubItem,
    addSubSubItem,
    removeSubSubItem,
    setChecklistViewers,
    setTemplateViewers,
    addChecklistTemplate,
    updateChecklistTemplate,
    updateChecklist,
    deleteChecklistTemplate,
    addChecklistTemplateItem,
    updateChecklistTemplateItem,
    setChecklistTemplateItemDueDate,
    setChecklistTemplateItemAssignee,
    reorderChecklistTemplateItems,
    bulkAddChecklistTemplateItems,
    removeChecklistTemplateItem,
    addChecklistTemplateSubItem,
    updateChecklistTemplateSubItem,
    removeChecklistTemplateSubItem,
    addChecklistTemplateSubSubItem,
    updateChecklistTemplateSubSubItem,
    removeChecklistTemplateSubSubItem,
    addTemplateStage,
    removeTemplateStage,
    patchTemplateStage,
    reorderTemplateStages,
    duplicateChecklistTemplate,
    createStandardTemplate,
    applyTemplateToClient,
    generateChecklistFromTemplate,
    reorderChecklistItems,
    bulkAddChecklistItems,
    createChecklist,
    updateChecklistItem,
    deleteChecklistItem,
    deleteChecklist,
    restoreChecklist,
    emptyChecklistRecycleBin,
    deleteTeamMember,
    updateClientPlan,
    updateClient,
    deleteClient,
    addClient,
    addPlan,
    updatePlan,
    deletePlan,
    addContact,
    updateContact,
    deleteContact,
    selectedClientId,
    setSelectedClientId,
    printInvoice,
    handleLogout,
    dataSyncState,
    syncMessage,
    firmSettings,
    setFirmSettings: (next: FirmSettings) => {
      const merged = { ...DEFAULT_FIRM_SETTINGS, ...next }
      setFirmSettings(merged)
      setPublicFirmSettings({
        name: merged.name,
        tagline: merged.tagline ?? '',
        logoUrl: merged.logoUrl ?? '',
        brandColor: merged.brandColor || '#3c2044',
        sidebarTextColor: merged.sidebarTextColor || '#ffffff',
        sidebarActiveTextColor: merged.sidebarActiveTextColor || '#ffffff',
      })
    },
  }

  return (
    <BrowserRouter>
      <AppContext.Provider value={contextValue}>
        <RoleAwareRoutes ownerMode={ownerMode} />
      </AppContext.Provider>
    </BrowserRouter>
  )
}

function RoleAwareRoutes({ ownerMode }: { ownerMode: boolean }) {
  // Sanitize: when a non-owner navigates (or refreshes) on an owner-only path,
  // bounce them off it. `ownerMode` is the EFFECTIVE role, so an owner who is
  // previewing a bookkeeper is bounced too — a faithful preview must not
  // expose pages the previewed person can't reach. While previewing we land
  // them on /dashboard; a real bookkeeper keeps the existing /time landing.
  const location = useLocation()
  const navigate = useNavigate()
  const { previewMode } = useAppContext()
  useEffect(() => {
    const ownerOnly = [
      '/time-approvals',
      '/reports',
      '/productivity',
      '/gantt',
      '/invoices',
      '/plans',
      '/contacts',
      '/team',
      '/cases',
      '/settings',
    ]
    if (!ownerMode && ownerOnly.some((path) => location.pathname.startsWith(path))) {
      navigate(previewMode ? '/dashboard' : '/time', { replace: true })
    }
  }, [location.pathname, navigate, ownerMode, previewMode])

  return (
    <Routes>
      {/* Authenticated visitors who land on the unauth entry pages get */}
      {/* bounced to the role-aware dashboard. */}
      <Route path="/staff" element={<Navigate to="/dashboard" replace />} />
      <Route path="/owner" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/time" element={<TimePage />} />
        <Route path="/timesheet" element={<TimesheetPage />} />
        <Route
          path="/time-approvals"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <TimeApprovalsPage />
            </OwnerOnly>
          }
        />
        <Route path="/checklists" element={<ChecklistsPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route
          path="/contacts"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ContactsPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/clients/:clientId"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ClientDetailPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/reports"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ReportsPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/productivity"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ProductivityPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/gantt"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <GanttPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/invoices"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <InvoicesPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/plans"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <PlansPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/team"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <TeamPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/settings"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <SettingsPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/cases/:caseId"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <CaseDetailPage />
            </OwnerOnly>
          }
        />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/two-factor/setup" element={<TwoFactorSetupPage />} />
        <Route path="*" element={<Navigate to="/time" replace />} />
      </Route>
    </Routes>
  )
}

export default App
