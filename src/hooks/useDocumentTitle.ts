import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { navItems } from '../components/navItems'

/**
 * Sets document.title to "<Page Label> · <Firm Name>" on each route change.
 * Falls back to just the firm name on unrecognized routes.
 */
export function useDocumentTitle(firmName: string) {
  const location = useLocation()

  useEffect(() => {
    const match = navItems.find((item) => {
      // Exact match, or prefix match for nested routes (e.g. /clients/123)
      return (
        location.pathname === item.to ||
        location.pathname.startsWith(item.to + '/')
      )
    })
    const label = match?.label
    document.title = label ? `${label} · ${firmName}` : firmName
  }, [location.pathname, firmName])
}
