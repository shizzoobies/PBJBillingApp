import { useSearchParams } from 'react-router-dom'

export type StatusFilter = 'all' | 'active' | 'overdue' | 'completed'

export function useFilters() {
  const [params, setParams] = useSearchParams()
  const assignee = params.get('assignee') ?? ''
  const client = params.get('client') ?? ''
  const status = (params.get('status') as StatusFilter | null) ?? 'all'

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'all') {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    setParams(next, { replace: true })
  }

  const clear = () => {
    const next = new URLSearchParams(params)
    next.delete('assignee')
    next.delete('client')
    next.delete('status')
    setParams(next, { replace: true })
  }

  const isActive = Boolean(assignee || client || (status && status !== 'all'))

  return {
    assignee,
    client,
    status,
    setAssignee: (value: string) => update('assignee', value),
    setClient: (value: string) => update('client', value),
    setStatus: (value: string) => update('status', value === 'all' ? '' : value),
    clear,
    isActive,
  }
}
