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
import { AppContext, type AppContextValue } from './AppContext'
import { AppLayout } from './components/AppLayout'
import { LoginScreen } from './components/LoginScreen'
import {
  appendChecklistItemsRequest,
  createTimeEntry,
  deleteChecklistItemRequest,
  fetchAppData,
  fetchLoginOptions,
  fetchSession,
  loginWithPassword,
  logoutSession,
  reorderChecklistItemsRequest,
  saveAppData,
  setChecklistViewersRequest,
  setTemplateViewersRequest,
  toggleChecklistItemRequest,
  updateChecklistItemRequest,
} from './lib/api'
import { createSeedData } from './lib/seed'
import {
  ApiError,
  type AppData,
  type AuthState,
  type BillingMode,
  type ChecklistTemplate,
  type Client,
  type DataSyncState,
  type LoginOption,
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
import { ChecklistsPage } from './pages/ChecklistsPage'
import { ClientsPage } from './pages/ClientsPage'
import { GanttPage } from './pages/GanttPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { PlansPage } from './pages/PlansPage'
import { ReportsPage } from './pages/ReportsPage'
import { TeamPage } from './pages/TeamPage'
import { TimePage } from './pages/TimePage'

function OwnerOnly({
  ownerMode,
  children,
}: {
  ownerMode: boolean
  children: React.ReactElement
}) {
  if (!ownerMode) {
    return <Navigate to="/time" replace />
  }
  return children
}

function App() {
  const [data, setData] = useState<AppData>(createSeedData)
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null)
  const [loginOptions, setLoginOptions] = useState<LoginOption[]>([])
  const [loginError, setLoginError] = useState('')
  const [loginPending, setLoginPending] = useState(false)
  const [dataSyncState, setDataSyncState] = useState<DataSyncState>('loading')
  const [serverPersistenceEnabled, setServerPersistenceEnabled] = useState(false)
  const [activeEmployeeId, setActiveEmployeeId] = useState('emp-avery')
  const [selectedClientId, setSelectedClientId] = useState('client-northstar')
  const [billingPeriod, setBillingPeriod] = useState(currentBillingPeriod())
  const [timer, setTimer] = useState<TimerState | null>(null)
  const [now, setNow] = useState(0)
  const skipAutosaveRef = useRef(0)
  const role = sessionUser?.role ?? 'employee'

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      try {
        const [loginResponse, sessionResponse] = await Promise.all([
          fetchLoginOptions(controller.signal),
          fetchSession(controller.signal),
        ])
        setLoginOptions(loginResponse.users)
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

  useEffect(() => {
    if (!sessionUser) {
      return
    }

    const controller = new AbortController()

    const load = async () => {
      try {
        const remoteData = ensureRecurringChecklists(await fetchAppData(controller.signal)).data
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
  }, [sessionUser])

  useEffect(() => {
    if (!serverPersistenceEnabled) {
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
  }, [data, serverPersistenceEnabled])

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
    setData((current) => ensureRecurringChecklists(updater(current)).data)
  }

  const applyServerDataUpdate = (updater: (current: AppData) => AppData) => {
    skipAutosaveRef.current += 1
    setData(updater)
  }

  const logTime = async (entry: Omit<TimeEntry, 'id'>) => {
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
    }
  }

  const stopTimer = async () => {
    if (!timer) {
      return
    }

    await logTime({
      employeeId: timer.employeeId,
      clientId: timer.clientId,
      date: new Date().toISOString().slice(0, 10),
      minutes: Math.max(1, Math.round((Date.now() - timer.startedAt) / 60000)),
      category: timer.category,
      description: timer.description,
      billable: true,
    })
    setTimer(null)
  }

  const toggleChecklistItem = async (checklistId: string, itemId: string) => {
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

  const setChecklistViewers = async (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => {
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

  const addChecklistTemplateItem = (templateId: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: [...template.items, { id: makeId('template-item'), label: 'New checklist item' }],
    }))
  }

  const updateChecklistTemplateItem = (templateId: string, itemId: string, label: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.map((item) => (item.id === itemId ? { ...item, label } : item)),
    }))
  }

  const removeChecklistTemplateItem = (templateId: string, itemId: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.filter((item) => item.id !== itemId),
    }))
  }

  const setChecklistTemplateItemDueDate = (
    templateId: string,
    itemId: string,
    dueDate: string,
  ) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.map((item) => {
        if (item.id !== itemId) {
          return item
        }
        const next = { ...item }
        if (!dueDate) {
          delete next.dueDate
        } else {
          next.dueDate = dueDate
        }
        return next
      }),
    }))
  }

  const setChecklistTemplateItemAssignee = (
    templateId: string,
    itemId: string,
    assigneeId: string,
  ) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.map((item) => {
        if (item.id !== itemId) {
          return item
        }
        const next = { ...item }
        if (!assigneeId) {
          delete next.assigneeId
        } else {
          next.assigneeId = assigneeId
        }
        return next
      }),
    }))
  }

  const reorderChecklistTemplateItems = (templateId: string, orderedIds: string[]) => {
    updateChecklistTemplate(templateId, (template) => {
      const byId = new Map(template.items.map((item) => [item.id, item]))
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((item): item is (typeof template.items)[number] => Boolean(item))
      const seen = new Set(orderedIds)
      const tail = template.items.filter((item) => !seen.has(item.id))
      return { ...template, items: [...next, ...tail] }
    })
  }

  const bulkAddChecklistTemplateItems = (templateId: string, labels: string[]) => {
    if (labels.length === 0) {
      return
    }
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: [
        ...template.items,
        ...labels.map((label) => ({ id: makeId('template-item'), label })),
      ],
    }))
  }

  const reorderChecklistItems = async (checklistId: string, orderedIds: string[]) => {
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
    if (labels.length === 0) return
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

  const updateChecklistItem = async (
    checklistId: string,
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
  ) => {
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
        items: source.items.map((item) => ({
          id: makeId('template-item'),
          label: item.label,
        })),
      }

      return {
        ...current,
        checklistTemplates: [...current.checklistTemplates, draft],
      }
    })
  }

  const updateClientPlan = (clientId: string, billingMode: BillingMode, planId: string | null) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.map((client) =>
        client.id === clientId ? { ...client, billingMode, planId } : client,
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

  const printInvoice = () => {
    window.setTimeout(() => window.print(), 50)
  }

  const startTimer = (nextTimer: TimerState) => {
    setNow(nextTimer.startedAt)
    setTimer(nextTimer)
  }

  const handleLogin = async (userId: string, password: string) => {
    setLoginPending(true)
    setLoginError('')

    try {
      const response = await loginWithPassword(userId, password)
      setSessionUser(response.user)
      if (response.user.role === 'employee') {
        setActiveEmployeeId(response.user.id)
      }
      setDataSyncState('loading')
    } catch (error) {
      setLoginError(
        error instanceof ApiError && error.status === 401 ? 'Invalid password.' : 'Login failed.',
      )
    } finally {
      setLoginPending(false)
    }
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

  const ownerMode = role === 'owner'
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
    return <LoginScreen loading loginOptions={loginOptions} onLogin={handleLogin} />
  }

  if (!sessionUser) {
    return (
      <LoginScreen
        error={loginError}
        loading={loginPending}
        loginOptions={loginOptions}
        onLogin={handleLogin}
      />
    )
  }

  const contextValue: AppContextValue = {
    data,
    sessionUser,
    role,
    ownerMode,
    activeEmployeeId,
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
    toggleChecklistItem,
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
    duplicateChecklistTemplate,
    reorderChecklistItems,
    bulkAddChecklistItems,
    updateChecklistItem,
    deleteChecklistItem,
    updateClientPlan,
    addClient,
    addPlan,
    selectedClientId,
    setSelectedClientId,
    printInvoice,
    handleLogout,
    dataSyncState,
    syncMessage,
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
  // Sanitize: when an employee navigates (or refreshes) on an owner-only path,
  // bounce them to /time. We do this in a hook so back/forward still works.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const ownerOnly = ['/reports', '/gantt', '/invoices', '/plans', '/team']
    if (!ownerMode && ownerOnly.some((path) => location.pathname.startsWith(path))) {
      navigate('/time', { replace: true })
    }
  }, [location.pathname, navigate, ownerMode])

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/time" replace />} />
        <Route path="/time" element={<TimePage />} />
        <Route path="/checklists" element={<ChecklistsPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route
          path="/reports"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ReportsPage />
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
        <Route path="*" element={<Navigate to="/time" replace />} />
      </Route>
    </Routes>
  )
}

export default App
