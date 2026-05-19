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
  appendChecklistItemsRequest,
  applyTemplateToClientRequest,
  approveTimeEntriesBatchRequest,
  approveTimeEntryRequest,
  createChecklistRequest,
  createStandardTemplateRequest,
  createTimeEntry,
  deleteChecklistItemRequest,
  deleteTimeEntryRequest,
  fetchAppData,
  fetchFirmSettings,
  fetchPublicFirmSettings,
  fetchSession,
  generateChecklistFromTemplateRequest,
  lockTimesheetRequest,
  logoutSession,
  rejectTimeEntryRequest,
  removeChecklistSubItemRequest,
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
import { createSeedData } from './lib/seed'
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type AppData,
  type AuthState,
  type BillingMode,
  type ChecklistTemplate,
  type Client,
  type DataSyncState,
  type FirmSettings,
  type PublicFirmSettings,
  type SessionUser,
  type SubscriptionPlan,
  type TimeEntry,
  type TimerState,
} from './lib/types'
import {
  currentBillingPeriod,
  ensureRecurringChecklists,
  formatTimeFromMs,
  getAssignedEmployeeIds,
  makeId,
  sortChecklists,
} from './lib/utils'
import { CaseDetailPage } from './pages/CaseDetailPage'
import { ChecklistsPage } from './pages/ChecklistsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ClientDetailPage } from './pages/ClientDetailPage'
import { ClientsPage } from './pages/ClientsPage'
import { GanttPage } from './pages/GanttPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { PlansPage } from './pages/PlansPage'
import { ProductivityPage } from './pages/ProductivityPage'
import { ReportsPage } from './pages/ReportsPage'
import { SettingsPage } from './pages/SettingsPage'
import { TeamPage } from './pages/TeamPage'
import { TimePage } from './pages/TimePage'
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
  const [data, setData] = useState<AppData>(createSeedData)
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
  })
  const skipAutosaveRef = useRef(0)
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
    const controller = new AbortController()

    const load = async () => {
      try {
        const sessionResponse = await fetchSession(controller.signal)
        setSessionUser(sessionResponse.user)
        if (sessionResponse.user?.role === 'employee') {
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

  // Push the firm brand color into the --plum CSS variable so it cascades to
  // the sidebar and other accent surfaces that already reference it.
  useEffect(() => {
    const color = publicFirmSettings.brandColor || '#3c2044'
    document.documentElement.style.setProperty('--plum', color)
  }, [publicFirmSettings.brandColor])

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

    if (skipAutosaveRef.current > 0) {
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

  const stopTimer = async () => {
    if (previewActiveRef.current || !timer) {
      return
    }

    await logTime({
      employeeId: timer.employeeId,
      clientId: timer.clientId,
      date: new Date().toISOString().slice(0, 10),
      minutes: Math.max(1, Math.round((Date.now() - timer.startedAt) / 60000)),
      description: timer.description,
      billable: true,
      taskId: timer.taskId ?? null,
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
    items: Array<{ label: string }>
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
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
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
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.filter((client) => client.id !== clientId),
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

  const printInvoice = () => {
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
  const syncMessage =
    dataSyncState === 'loading'
      ? 'Loading server-backed workspace data...'
      : dataSyncState === 'saving'
        ? 'Saving changes to the server...'
        : dataSyncState === 'synced'
          ? 'Server-backed persistence is active.'
          : dataSyncState === 'error'
            ? 'Latest changes could not be saved to the server.'
            : 'API unavailable. Showing seed data until the backend is reachable.'

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
            path="/owner"
            element={
              <SignInScreen
                role="owner"
                heading="Owner sign-in"
                firmSettings={publicFirmSettings}
              />
            }
          />
          <Route
            path="/staff"
            element={
              <SignInScreen
                role="staff"
                heading="Staff sign-in"
                firmSettings={publicFirmSettings}
              />
            }
          />
          <Route path="/two-factor" element={<TwoFactorPage />} />
          <Route path="/two-factor/setup" element={<TwoFactorSetupPage forced />} />
          <Route path="*" element={<Navigate to="/staff" replace />} />
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
    visibleEntries,
    billingPeriod,
    setBillingPeriod,
    timer,
    timerElapsed: timer ? formatTimeFromMs(now - timer.startedAt) : '0:00',
    startTimer,
    stopTimer,
    logTime,
    updateTimeEntry,
    deleteTimeEntry,
    approveTimeEntry,
    rejectTimeEntry,
    approveTimeEntriesBatch,
    lockTimesheet,
    unlockTimesheet,
    toggleChecklistItem,
    toggleSubItem,
    addSubItem,
    removeSubItem,
    setChecklistViewers,
    setTemplateViewers,
    addChecklistTemplate,
    updateChecklistTemplate,
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
    updateClientPlan,
    updateClient,
    deleteClient,
    addClient,
    addPlan,
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
