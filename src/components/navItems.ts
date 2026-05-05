import {
  Activity,
  BarChart3,
  Building2,
  Clock3,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  ReceiptText,
  Settings,
  Users,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'

export const navItems: Array<{
  to: string
  label: string
  icon: LucideIcon
  ownerOnly?: boolean
}> = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/time', label: 'Time', icon: Clock3 },
  { to: '/checklists', label: 'Checklists', icon: ListChecks },
  { to: '/clients', label: 'Clients', icon: Building2 },
  { to: '/reports', label: 'Reports', icon: FolderKanban, ownerOnly: true },
  { to: '/productivity', label: 'Productivity', icon: Activity, ownerOnly: true },
  { to: '/gantt', label: 'Gantt', icon: BarChart3, ownerOnly: true },
  { to: '/invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true },
  { to: '/plans', label: 'Plans', icon: WalletCards, ownerOnly: true },
  { to: '/team', label: 'Team', icon: Users, ownerOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, ownerOnly: true },
]
