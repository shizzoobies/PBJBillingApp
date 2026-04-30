import {
  BarChart3,
  Building2,
  Clock3,
  FolderKanban,
  ListChecks,
  ReceiptText,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'

export const navItems: Array<{
  to: string
  label: string
  icon: LucideIcon
  ownerOnly?: boolean
}> = [
  { to: '/time', label: 'Time', icon: Clock3 },
  { to: '/checklists', label: 'Checklists', icon: ListChecks },
  { to: '/clients', label: 'Clients', icon: Building2 },
  { to: '/reports', label: 'Reports', icon: FolderKanban, ownerOnly: true },
  { to: '/gantt', label: 'Gantt', icon: BarChart3, ownerOnly: true },
  { to: '/invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true },
  { to: '/plans', label: 'Plans', icon: WalletCards, ownerOnly: true },
]
