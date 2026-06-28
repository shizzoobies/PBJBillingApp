import {
  Activity,
  AlarmClock,
  BarChart3,
  BookUser,
  Building2,
  CalendarRange,
  CircleCheckBig,
  ClipboardCheck,
  Clock3,
  FileBarChart,
  FolderKanban,
  Kanban,
  LayoutDashboard,
  ListChecks,
  Megaphone,
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
  { to: '/timesheet', label: 'Timesheet', icon: CalendarRange },
  { to: '/time-approvals', label: 'Time Approvals', icon: ClipboardCheck, ownerOnly: true },
  { to: '/checklists', label: 'Checklists', icon: ListChecks },
  { to: '/board', label: 'Board', icon: Kanban },
  { to: '/delayed', label: 'Delayed', icon: AlarmClock },
  { to: '/clients', label: 'Clients', icon: Building2 },
  { to: '/client-recap', label: 'Client Recap', icon: FileBarChart, ownerOnly: true },
  { to: '/contacts', label: 'Contacts', icon: BookUser, ownerOnly: true },
  { to: '/reports', label: 'Reports', icon: FolderKanban, ownerOnly: true },
  { to: '/productivity', label: 'Productivity', icon: Activity, ownerOnly: true },
  { to: '/gantt', label: 'Gantt', icon: BarChart3 },
  { to: '/invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true },
  { to: '/plans', label: 'Plans', icon: WalletCards, ownerOnly: true },
  { to: '/team', label: 'Team', icon: Users, ownerOnly: true },
  { to: '/setup', label: 'To 100%', icon: CircleCheckBig, ownerOnly: true },
  { to: '/updates', label: 'Updates', icon: Megaphone, ownerOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, ownerOnly: true },
]
