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
  Handshake,
  Kanban,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Receipt,
  ReceiptText,
  Settings,
  Users,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  ownerOnly?: boolean
}

/**
 * A run of nav links. A section with no `label` renders its items bare, with no
 * heading — that is how the standalone entries (Dashboard, Engagements, Team,
 * Updates) appear. Grouping a lone link under its own heading is more chrome
 * than content, so single-item sections deliberately have no label.
 */
export type NavSection = {
  label?: string
  items: NavItem[]
}

const DASHBOARD: NavItem = { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }
const TIME: NavItem = { to: '/time', label: 'Time', icon: Clock3 }
const TIMESHEET: NavItem = { to: '/timesheet', label: 'Timesheet', icon: CalendarRange }
const TIME_APPROVALS: NavItem = {
  to: '/time-approvals',
  label: 'Time Approvals',
  icon: ClipboardCheck,
  ownerOnly: true,
}
const CHECKLISTS: NavItem = { to: '/checklists', label: 'Checklists', icon: ListChecks }
const BOARD: NavItem = { to: '/board', label: 'Board', icon: Kanban }
const DELAYED: NavItem = { to: '/delayed', label: 'Delayed', icon: AlarmClock }
const GANTT: NavItem = { to: '/gantt', label: 'Gantt', icon: BarChart3 }
const ENGAGEMENTS: NavItem = {
  to: '/engagements',
  label: 'Engagements',
  icon: Handshake,
  ownerOnly: true,
}
const CLIENTS: NavItem = { to: '/clients', label: 'Clients', icon: Building2 }
const CLIENT_RECAP: NavItem = {
  to: '/client-recap',
  label: 'Client Recap',
  icon: FileBarChart,
  ownerOnly: true,
}
const CONTACTS: NavItem = { to: '/contacts', label: 'Contacts', icon: BookUser, ownerOnly: true }
const INVOICES: NavItem = { to: '/invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true }
// NOT ownerOnly — the one invoicing surface staff can see (featreq-0c2d4ce5):
// the monthly totals + reimbursed-expense breakout they record transactions
// from, server-scoped to each viewer's assigned clients.
const INVOICE_RECAP: NavItem = { to: '/invoice-recap', label: 'Invoice Recap', icon: Receipt }
const PLANS: NavItem = { to: '/plans', label: 'Plans', icon: WalletCards, ownerOnly: true }
const REPORTS: NavItem = { to: '/reports', label: 'Reports', icon: FolderKanban, ownerOnly: true }
const PRODUCTIVITY: NavItem = {
  to: '/productivity',
  label: 'Productivity',
  icon: Activity,
  ownerOnly: true,
}
const TEAM: NavItem = { to: '/team', label: 'Team', icon: Users, ownerOnly: true }
const SETUP: NavItem = { to: '/setup', label: 'To 100%', icon: CircleCheckBig, ownerOnly: true }
const UPDATES: NavItem = { to: '/updates', label: 'Updates', icon: Megaphone, ownerOnly: true }
const SETTINGS: NavItem = { to: '/settings', label: 'Settings', icon: Settings, ownerOnly: true }

/**
 * Every nav destination, flat and in the order STAFF see them (which is the
 * order this list has always had — staff keep an ungrouped sidebar, because at
 * eight links the headings would outweigh the content).
 *
 * Also the lookup table for `useDocumentTitle`, so every routed page must
 * appear here even when it only shows inside a group.
 */
export const navItems: NavItem[] = [
  DASHBOARD,
  TIME,
  TIMESHEET,
  TIME_APPROVALS,
  CHECKLISTS,
  BOARD,
  DELAYED,
  ENGAGEMENTS,
  CLIENTS,
  CLIENT_RECAP,
  CONTACTS,
  REPORTS,
  PRODUCTIVITY,
  GANTT,
  INVOICES,
  INVOICE_RECAP,
  PLANS,
  TEAM,
  SETUP,
  UPDATES,
  SETTINGS,
]

/**
 * The OWNER's grouped sidebar (P1 of the billing & engagements plan). Section
 * order follows the sections Brittany named — Engagements, Clients, Billing,
 * Operations, Team, Reports, Settings — rather than the order the pages happen
 * to have been built in.
 *
 * Same item objects as `navItems`, so a label or route is only ever defined
 * once and the two views cannot drift apart.
 */
export const navSections: NavSection[] = [
  { items: [DASHBOARD] },
  // Nothing lives here until the intake form and proposals ship (P2/P3); the
  // page itself explains that, so the section is visible rather than a
  // surprise appearing later.
  { items: [ENGAGEMENTS] },
  { label: 'Clients', items: [CLIENTS, CONTACTS, CLIENT_RECAP] },
  { label: 'Billing', items: [INVOICES, INVOICE_RECAP, PLANS] },
  {
    label: 'Operations',
    items: [TIME, TIMESHEET, TIME_APPROVALS, CHECKLISTS, BOARD, DELAYED, GANTT],
  },
  { items: [TEAM] },
  { label: 'Reports', items: [REPORTS, PRODUCTIVITY] },
  // Top-level on purpose: this is how Brittany files requests and sees what
  // shipped, and she wants it visible rather than tucked under Settings.
  { items: [UPDATES] },
  { label: 'Settings', items: [SETTINGS, SETUP] },
]
