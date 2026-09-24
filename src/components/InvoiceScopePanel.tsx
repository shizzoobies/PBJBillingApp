import type {
  AdhocMode,
  Checklist,
  Employee,
  TimeEntry,
  TimesheetLock,
} from '../lib/types'
import { decimalHours, formatHoursTotal, taskTitleFor } from '../lib/utils'
import { displayHours, sumDisplayHours } from '../lib/payrollAggregation'
import {
  scopeTagOfEntry,
  type ScopeTag,
  type ScopeTagEdits,
} from '../../lib/invoice-scope-retag.js'

/**
 * THE HOURS BEHIND THE INVOICE SHE IS LOOKING AT — featreq-8cec48db.
 *
 * Brittany: "when reviewing an invoice there is no quick way to see the hours
 * logged for that client, so out-of-scope or adhoc work slips onto the
 * invoice." This is the panel beside the open invoice that answers it: every
 * time entry the invoice's period and client cover, grouped by team member,
 * with the scope decision on each line.
 *
 * TWO THINGS SHE DECIDED, and they are the whole shape of this:
 *
 *   1. The tags STAGE and apply together when the invoice is saved, not live
 *      per click. So nothing here calls the server. Every control writes into
 *      the editor's staged map, the running total below the lines already
 *      reflects it, and one Save writes the lines and the hours together.
 *   2. It SHOWS the tag already made at time entry / time review and lets her
 *      OVERRIDE it — "the final catch in the invoicing side". So the current
 *      value of every select is read off the ENTRY, not off the invoice, and a
 *      staged override is marked rather than hidden.
 *
 * The three tags are a view of the two booleans already on the entry, so
 * nothing new is stored on a time entry to make this work.
 */

/** The three tags, worded from the invoice's point of view. */
const SCOPE_CHOICES: ReadonlyArray<{ value: ScopeTag; label: string }> = [
  { value: 'in-scope', label: 'In scope' },
  { value: 'out-of-scope', label: 'Out of scope' },
  { value: 'adhoc', label: 'Ad hoc' },
]

/**
 * What she can decide about ad hoc work, in the order the decision usually
 * goes. Deliberately the SAME three options, worded the same way, as the ad hoc
 * block in the lines table above — this panel offers the existing choice from a
 * second place, it does not invent a fourth.
 */
const ADHOC_CHOICES: ReadonlyArray<{ value: AdhocMode; label: string }> = [
  { value: 'billed', label: 'Invoice it' },
  { value: 'courtesy', label: 'Show detail only ($0.00)' },
  { value: 'omitted', label: 'Leave off the invoice' },
]

/**
 * The one thing she needs to know before using the middle option: out of scope
 * is a statement about the WORK, and it travels well beyond this invoice.
 */
const SCOPE_HINT =
  'Out of scope takes the hours out of billable time everywhere — reports and analytics included. To keep the hours billable but off this invoice, use Ad hoc → Leave off the invoice.'

/** A row as the panel shows it: the entry, plus what it is tagged right now. */
type ScopeRow = {
  entry: TimeEntry
  /** The entry's own tag, from its stored flags. */
  saved: ScopeTag
  /** What it will be after the save — the staged override, or `saved`. */
  effective: ScopeTag
  staged: boolean
  adhocMode: AdhocMode
  locked: boolean
}

type MemberGroup = {
  key: string
  memberName: string
  /** On a billing master, the company whose work this is. */
  companyKey: string
  companyName: string
  rows: ScopeRow[]
  hours: Record<ScopeTag, number>
}

export function InvoiceScopePanel({
  entries,
  employees,
  checklists,
  timesheetLocks = [],
  period,
  tagEdits,
  savedAdhocModes = {},
  onTagChange,
  applicable,
  blocked = [],
  readOnly,
  isBillingMaster = false,
  sourceClientName,
}: {
  /** The entries this invoice covers, already narrowed to its client + period. */
  entries: TimeEntry[]
  employees: Employee[]
  checklists: Checklist[]
  timesheetLocks?: TimesheetLock[]
  period: string
  tagEdits: ScopeTagEdits
  /**
   * What the invoice's OWN ad hoc line already says about each entry, keyed by
   * entry id. Without it a row that is already ad hoc at "Show detail only"
   * would show "Invoice it" and quietly re-bill the work the moment she touched
   * anything else on the row.
   */
  savedAdhocModes?: Record<string, AdhocMode>
  onTagChange: (entryId: string, tag: ScopeTag, adhocMode?: AdhocMode) => void
  /**
   * Whether re-tagging can move any money on THIS invoice — false on
   * subscription, annual and pre-cutover invoices, which have no per-employee
   * hourly lines to move hours between.
   */
  applicable: boolean
  /**
   * Entry ids whose tag the invoice's lines do not carry — the hours could not
   * be taken off the line they are billed on, so nothing was added either.
   * Nearly always a retyped hourly line with no hours or rate: most lines on a
   * real invoice have been renamed by hand. Said on the row, because a tag that
   * quietly moved no money would be worse than one that says so — and said
   * whether the tag is STAGED or already saved, because a blocked tag saves
   * anyway and the line is still unadjusted on the other side of the remount.
   */
  blocked?: string[]
  /** Preview mode, or an invoice past the point where lines may change. */
  readOnly: boolean
  isBillingMaster?: boolean
  /** A sub's client id to that company's name, for a master's group headings. */
  sourceClientName?: (clientId: string) => string
}) {
  const blockedIds = new Set(blocked)

  const employeeName = (employeeId: string) =>
    employees.find((employee) => employee.id === employeeId)?.name ?? 'Unknown'

  // Who is locked out of this month. An OWNER is exempt from the lock (the
  // server says so), so this is a note on the row rather than a block: she is
  // allowed to make this decision, and being told the month was signed off is
  // the useful part.
  const lockedMembers = new Set(
    timesheetLocks
      .filter((lock) => lock.period === period)
      .map((lock) => lock.userId),
  )

  const groups: MemberGroup[] = []
  const byKey = new Map<string, MemberGroup>()
  for (const entry of entries) {
    const companyKey = isBillingMaster ? entry.clientId : ''
    const key = `${companyKey}::${entry.employeeId}`
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        memberName: employeeName(entry.employeeId),
        companyKey,
        companyName: companyKey ? (sourceClientName?.(companyKey) ?? companyKey) : '',
        rows: [],
        hours: { 'in-scope': 0, 'out-of-scope': 0, adhoc: 0 },
      }
      byKey.set(key, group)
      groups.push(group)
    }
    const saved = scopeTagOfEntry(entry)
    const edit = tagEdits[entry.id]
    const effective = edit?.tag ?? saved
    group.rows.push({
      entry,
      saved,
      effective,
      // A staged choice that lands on the tag the entry already has moves
      // nothing, so it is not announced as pending. Ad hoc is the exception:
      // what to DO with it can still have changed.
      staged: Boolean(edit) && (effective !== saved || effective === 'adhoc'),
      adhocMode: edit?.adhocMode ?? savedAdhocModes[entry.id] ?? 'billed',
      locked: lockedMembers.has(entry.employeeId),
    })
  }

  // Companies, then people, then dates — the order she reads them in. Sorting
  // the DISPLAY only; nothing about the invoice's lines is touched by it.
  groups.sort(
    (left, right) =>
      left.companyName.localeCompare(right.companyName) ||
      left.memberName.localeCompare(right.memberName),
  )
  for (const group of groups) {
    group.rows.sort(
      (left, right) =>
        String(left.entry.date).localeCompare(String(right.entry.date)) ||
        String(left.entry.description ?? '').localeCompare(String(right.entry.description ?? '')),
    )
    // Subtotals off the EFFECTIVE tag, so the three figures describe the
    // invoice she is about to save rather than the one she opened. Summed as
    // two-decimal hours, the same rule the invoice's own lines are priced by.
    for (const tag of ['in-scope', 'out-of-scope', 'adhoc'] as ScopeTag[]) {
      group.hours[tag] = sumDisplayHours(
        group.rows
          .filter((row) => row.effective === tag)
          .map((row) => displayHours(row.entry.minutes)),
      )
    }
  }

  const disabled = readOnly || !applicable

  return (
    <aside className="invoice-scope" aria-label="Hours logged for this client">
      <div className="invoice-scope-head">
        <h3>Hours this period</h3>
        {readOnly ? (
          <p className="invoice-scope-note">
            This invoice is past the point where its lines can change, so the tags are shown
            read-only.
          </p>
        ) : !applicable ? (
          <p className="invoice-scope-note">
            Re-tagging moves hours between this client&rsquo;s billable lines and its ad hoc
            lines, which only exist on an hourly invoice from June 2026 on. The hours are shown
            here for reference; change the tags on the Time page instead.
          </p>
        ) : (
          <p className="invoice-scope-note">{SCOPE_HINT}</p>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="invoice-scope-empty">No time was logged for this client this period.</p>
      ) : (
        <div className="table-wrap">
        <table className="invoice-scope-panel">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col">Task</th>
              <th scope="col" className="invoice-scope-hours">
                Hours
              </th>
              <th scope="col">Scope</th>
            </tr>
          </thead>
          {groups.map((group, index) => {
            const newCompany =
              isBillingMaster && group.companyKey !== (groups[index - 1]?.companyKey ?? null)
            return (
              <tbody key={group.key}>
                {newCompany ? (
                  <tr className="invoice-scope-company">
                    <th colSpan={5} scope="colgroup">
                      {group.companyName}
                    </th>
                  </tr>
                ) : null}
                <tr className="invoice-scope-member">
                  <th colSpan={4} scope="colgroup">
                    {group.memberName}
                  </th>
                  <td className="invoice-scope-subtotals">
                    <span>{formatHoursTotal(group.hours['in-scope'])} in scope</span>
                    <span>{formatHoursTotal(group.hours.adhoc)} ad hoc</span>
                    <span>{formatHoursTotal(group.hours['out-of-scope'])} out of scope</span>
                  </td>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.entry.id}>
                    <td className="invoice-scope-date">{row.entry.date}</td>
                    <td>{row.entry.description}</td>
                    <td>{taskTitleFor(checklists, row.entry)}</td>
                    <td className="invoice-scope-hours">{decimalHours(row.entry.minutes)}</td>
                    <td className="invoice-scope-choice">
                      <select
                        className="input"
                        aria-label={`Scope for ${row.entry.description || 'this entry'} on ${row.entry.date}`}
                        disabled={disabled}
                        value={row.effective}
                        onChange={(event) =>
                          onTagChange(
                            row.entry.id,
                            event.target.value as ScopeTag,
                            event.target.value === 'adhoc' ? row.adhocMode : undefined,
                          )
                        }
                      >
                        {SCOPE_CHOICES.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                      {/* Only ad hoc work has a second decision to make, and it
                          is the SAME three options the lines table offers. */}
                      {row.effective === 'adhoc' ? (
                        <select
                          className="input"
                          aria-label={`What to do with this ad hoc work on ${row.entry.date}`}
                          disabled={disabled}
                          value={row.adhocMode}
                          onChange={(event) =>
                            onTagChange(
                              row.entry.id,
                              'adhoc',
                              event.target.value as AdhocMode,
                            )
                          }
                        >
                          {ADHOC_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {blockedIds.has(row.entry.id) ? (
                        <span className="invoice-scope-blocked">
                          The tag stands, but these hours are on a renamed line — adjust the
                          invoice line yourself.
                        </span>
                      ) : row.staged ? (
                        <span className="invoice-scope-staged">Will apply on save</span>
                      ) : null}
                      {row.locked ? (
                        <span className="invoice-scope-locked">Month locked</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            )
          })}
        </table>
        </div>
      )}
    </aside>
  )
}
