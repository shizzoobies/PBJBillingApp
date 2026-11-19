import type { TimeEntry, WorkSession } from './types'
import { effectiveSessions, formatHoursMinutes, sessionMinutes } from './utils'
import { displayHours } from './payrollAggregation'

/**
 * What the payroll report says about WHEN an entry's time was worked, and how
 * that squares with the Hours on its row (featreq-2da633de).
 *
 * An entry's clock times and its Hours normally agree. They stop agreeing, on
 * purpose, in three ways, and each one read as a broken report until the page
 * said which it was:
 *  - the entry was stopped and picked up again: first start and last stop are
 *    hours apart, the time worked is only the stretches;
 *  - the entry is one client's SHARE of a block split across clients: every
 *    share carries the block's clock times, and only its own minutes;
 *  - the Hours were typed, not clocked: a typed duration is what is billed and
 *    the clock times stay as they were.
 *
 * Every sentence built here is worded to stay TRUE after the edits the app
 * allows on a share (Adjust split, a retyped share, Resume on one share, a
 * share moved to another client, day or person, or to administrative time): it
 * states what the rows hold ("the shares total 39m"), never what the block
 * "was", and it says less rather than guess when the shares no longer look like
 * one split.
 */

type ClockEntry = Pick<
  TimeEntry,
  'minutes' | 'sessions' | 'startAt' | 'endAt' | 'groupId' | 'groupAllocation' | 'clientId'
>

export type ClockSpans = {
  /** The stretches with real times, earliest start first (stored order is the order they were typed or added). */
  spans: WorkSession[]
  /** The EARLIEST start and the LATEST stop: what "Clock in" and "Clock out" mean. */
  firstStart?: string
  lastStop?: string
  /** The time inside the stretches, in minutes. */
  clockMinutes: number
}

export function clockSpansOf(entry: Pick<TimeEntry, 'sessions' | 'startAt' | 'endAt'>): ClockSpans {
  const spans = effectiveSessions(entry)
    .filter((span) => {
      const start = new Date(span.startAt).getTime()
      const end = new Date(span.endAt).getTime()
      return !Number.isNaN(start) && !Number.isNaN(end) && end > start
    })
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
  if (spans.length === 0) return { spans, clockMinutes: 0 }
  const lastStopMs = Math.max(...spans.map((span) => new Date(span.endAt).getTime()))
  return {
    spans,
    firstStart: spans[0].startAt,
    lastStop: new Date(lastStopMs).toISOString(),
    clockMinutes: spans.reduce((sum, span) => sum + sessionMinutes(span), 0),
  }
}

/**
 * What one entry's single report row shows, in the units it is printed in: the
 * Hours and Billable hours at two decimals, Billable $ and Cost to the cent
 * (`null` = no rate on file, printed "—" or blank, never $0.00).
 */
export type EntryFigures = {
  hours: number
  billableHours: number
  amount: number | null
  cost: number | null
}

/** An entry's figures as its one row prints them: its minutes at two decimals, and the money cells it was given. */
export function entryFigures(
  entry: Pick<TimeEntry, 'minutes' | 'billable'>,
  amount: number | null,
  cost: number | null,
): EntryFigures {
  const hours = displayHours(entry.minutes)
  return { hours, billableHours: entry.billable ? hours : 0, amount, cost }
}

/** One row of the payroll report: one stretch of one entry (featreq-2da633de, sent back 2026-11-18). */
export type StretchRow = EntryFigures & {
  /** Which stretch, 1-based, and how many the entry has; `of` is 1 for a single stretch or minutes only. */
  index: number
  of: number
  /** "2 of 4" for a stretch of an entry worked in several; '' for a single stretch or minutes only. */
  label: string
  /** This stretch's own start and stop; absent for an entry logged as minutes only. */
  startAt?: string
  endAt?: string
}

/**
 * Whole `units` handed out in proportion to `weights` so they ADD BACK EXACTLY:
 * every part starts at the floor of its exact share, and the units left over
 * go one each to the largest remainders, the EARLIER stretch on every tie.
 *
 * In whole numbers throughout, so float noise never decides a tie: weights are
 * read in tenths of a second (stretch lengths are whole seconds; hundredths of
 * an hour are whole numbers too), and each remainder is the integer left over
 * by `units x weight / total`. A negative total (negative minutes) is split as
 * its size and handed back negative. Weights below zero count as none; with no
 * weight at all, everything goes to the first.
 */
export function largestRemainder(units: number, weights: readonly number[]): number[] {
  if (units < 0) return largestRemainder(-units, weights).map((part) => (part === 0 ? 0 : -part))
  const scaled = weights.map((weight) => Math.max(0, Math.round(weight * 600)))
  const total = scaled.reduce((sum, weight) => sum + weight, 0)
  if (total === 0) return weights.map((_, index) => (index === 0 ? units : 0))
  const parts = scaled.map((weight) => Math.floor((units * weight) / total))
  const remainders = scaled.map((weight) => (units * weight) % total)
  let left = units - parts.reduce((sum, value) => sum + value, 0)
  const order = remainders
    .map((remainder, index) => ({ index, remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (let k = 0; left > 0; k++, left--) parts[order[k % order.length].index] += 1
  return parts
}

const toUnits = (value: number) => Math.round(Number((value * 100).toFixed(6)))
const fromUnits = (units: number) => (units === 0 ? 0 : units / 100)

/**
 * ONE ROW PER STRETCH: an entry's single report row cut into one row for each
 * stretch it was worked in, earliest first. The screen and both sheets build
 * their rows here, so the three cannot disagree.
 *
 * The entry's Hours and Billable hours (in hundredths) are divided across its
 * stretches in proportion to their lengths, and its Billable $ and Cost (in
 * cents) in proportion to the hours that gives each row, largest remainder
 * first, so the pieces ADD BACK EXACTLY to the one row's figures, every total
 * over them is the same as before, and a row's money is its own hours times
 * the rate whenever the entry's was. For an ordinary entry that is each
 * stretch's own length, give or take the hundredth that makes the pieces add
 * up; for a share of a block split across clients, or hours typed in, it is
 * the entry's own time spread over its stretches. A `null` amount or cost
 * stays `null` on every piece.
 *
 * An entry with one stretch, or logged as minutes only, is one row, its
 * figures unchanged and its Stretch label blank.
 *
 * `spans` are the entry's stretches as `clockSpansOf` gives them (real times,
 * earliest first).
 */
export function stretchRows(spans: readonly WorkSession[], figures: EntryFigures): StretchRow[] {
  if (spans.length <= 1) {
    return [{ ...figures, index: 1, of: 1, label: '', startAt: spans[0]?.startAt, endAt: spans[0]?.endAt }]
  }
  const lengths = spans.map((span) => sessionMinutes(span))
  const split = (value: number, weights: readonly number[]) =>
    largestRemainder(toUnits(value), weights.some((weight) => weight > 0) ? weights : lengths).map(fromUnits)
  const hours = split(figures.hours, lengths)
  const billableHours = split(figures.billableHours, lengths)
  // Money follows the HOURS ON THE ROW, not the raw lengths, so a row's Hours
  // times the rate gives the money beside it, as on every other row of the
  // report (0.84h at $90 reads $75.60, never $75.13).
  const splitMoney = (value: number | null, rowHours: readonly number[]) =>
    value === null ? spans.map(() => null) : split(value, rowHours.map(toUnits))
  const amount = splitMoney(figures.amount, billableHours)
  const cost = splitMoney(figures.cost, hours)
  return spans.map((span, i) => ({
    hours: hours[i],
    billableHours: billableHours[i],
    amount: amount[i],
    cost: cost[i],
    index: i + 1,
    of: spans.length,
    label: `${i + 1} of ${spans.length}`,
    startAt: span.startAt,
    endAt: span.endAt,
  }))
}

/**
 * The Stretch cell of a SHEET row: "1 of 1" for an entry worked in one
 * stretch, so a sorted sheet never shows a blank that reads as "no clock
 * times"; blank only for an entry logged as minutes. (The screen keeps a
 * single stretch blank.)
 */
export function sheetStretchLabel(row: StretchRow): string {
  return row.label || (row.startAt ? '1 of 1' : '')
}

/**
 * The "Entry #" and "Split block #" columns of a sheet, so rows can be
 * regrouped after the sheet is sorted: short numbers handed out in the sheet's
 * own order, the same on every row of one entry and, for split blocks, on every
 * row of every client's part of one block (by its group, the key
 * `buildSplitBlocks` reads them by). Blank for an entry that is not a share.
 */
export function sheetNumbers() {
  const entries = new Map<string, number>()
  const blocks = new Map<string, number>()
  const numberOf = (map: Map<string, number>, key: string) => {
    if (!map.has(key)) map.set(key, map.size + 1)
    return map.get(key) as number
  }
  return (entry: Pick<TimeEntry, 'id' | 'groupId'>) => ({
    entry: numberOf(entries, entry.id),
    block: entry.groupId ? numberOf(blocks, entry.groupId) : '',
  })
}

/** The shares of one block of time split across clients, as the rows hold them now. */
export type SplitBlock = {
  mode: 'even' | 'custom' | 'full'
  shares: number
  /** Distinct CLIENTS among the shares. A share moved to administrative time has none. */
  clients: number
  /** The shares added up (what an even or custom split's rows total). */
  minutes: number
  /** Full mode repeats the block on every share: true while every share still holds the same time. */
  uniform: boolean
}

const MODES = new Set(['even', 'custom', 'full'])

/**
 * The split blocks among these entries, by group id. Hand it EVERY entry, not
 * just the period on screen: a share moved to another day still belongs to its
 * block, and its siblings are still shares of one.
 *
 * A group is left out, and nothing is then claimed about it, when its shape is
 * not known: a share with no recorded mode (a split made with "Log time
 * manually", which records none, or one saved before modes were recorded), or
 * shares that disagree about the mode.
 */
export function buildSplitBlocks(entries: ReadonlyArray<ClockEntry>): Map<string, SplitBlock> {
  const groups = new Map<string, ClockEntry[]>()
  for (const entry of entries) {
    if (!entry.groupId) continue
    groups.set(entry.groupId, [...(groups.get(entry.groupId) ?? []), entry])
  }
  const blocks = new Map<string, SplitBlock>()
  for (const [groupId, shares] of groups) {
    const mode = shares[0].groupAllocation
    if (!mode || !MODES.has(mode) || shares.some((share) => share.groupAllocation !== mode)) continue
    const minutes = shares.map((share) => share.minutes)
    blocks.set(groupId, {
      mode,
      shares: shares.length,
      clients: new Set(shares.map((share) => share.clientId).filter(Boolean)).size,
      minutes: minutes.reduce((sum, value) => sum + value, 0),
      uniform: Math.max(...minutes) - Math.min(...minutes) < 1 / 60,
    })
  }
  return blocks
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The line under the first row of a share's Hours (on the page; on every row
 * of a sheet). It says the share's OWN time first ("13m of ..."), because that
 * is the figure its Hours are: 13 minutes is 0.22h, rounded like every other
 * entry, so three such shares add to 0.66h on the report though they total 39
 * minutes. The words for her are "part" and "shared", never "share".
 *
 * The part and the whole go in one phrase ("13m of a 39m block shared by 3
 * clients") ONLY while that is true: the parts must still add up to this
 * entry's own clock time. After an Adjust split that changed the total, a
 * retyped part, time added to one part (Resume on one only), or a part removed,
 * the block's size is no longer one figure, and the line says what the rows
 * hold instead: "10m part of a block shared by 3 clients (the parts total
 * 30m)", with the mismatch line under it.
 *
 * `forExport` adds, for a full-mode share, that its hours count once: the
 * screen says that on the repeated rows themselves.
 *
 * On an entry worked in more than one stretch the line starts "This entry: ",
 * because it quotes the ENTRY's minutes while the row it sits under shows one
 * stretch ("0.01h" over "13m of a 39m block ..."). A sheet repeats the line on
 * every row, so it carries the same form.
 */
export function splitNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  options: { forExport?: boolean } = {},
): string {
  const note = entrySplitNote(entry, blocks, options)
  return note && clockSpansOf(entry).spans.length > 1 ? `This entry: ${note}` : note
}

function entrySplitNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  { forExport = false }: { forExport?: boolean },
): string {
  if (!entry.groupId) return ''
  const block = blocks.get(entry.groupId)
  if (!block) return 'part of a block shared by several clients'
  const own = formatHoursMinutes(entry.minutes)
  // Moved off its client since the split: it is no longer anyone's part to bill.
  if (!entry.clientId) return `${own} part of a shared block, moved to administrative time`
  if (block.shares === 1) return `${own}, the one remaining part of a shared block`
  if (block.mode === 'full') {
    const once = forExport ? '; hours counted once' : ''
    // Every share repeats the block. Once one share was changed on its own,
    // only this row's own time can be stated.
    return block.uniform && block.clients === block.shares
      ? `full ${own} block billed to each of ${count(block.clients, 'client')}${once}`
      : `${own} billed in full to this client, one of ${count(block.shares, 'part')} of one block${once}`
  }
  // Parts that no longer sit on different clients are counted as parts.
  const spread = block.clients > 1 ? `shared by ${count(block.clients, 'client')}` : `split into ${count(block.shares, 'part')}`
  const total = formatHoursMinutes(block.minutes)
  const whole = Math.abs(block.minutes - clockSpansOf(entry).clockMinutes) <= CLOCK_TOLERANCE_MINUTES
  return whole
    ? `${own} of a ${total} block ${spread}`
    : `${own} part of a block ${spread} (the parts total ${total})`
}

/**
 * The SHORT line under the Hours of every LATER row of a share (the first row
 * carries `splitNote`), so a 5:05-5:42 row reading 0.21h explains itself.
 * Says only what is true of the row in every state: it holds part of this
 * entry's time, and the entry is a client's part of a shared block (or, in
 * full mode, the block billed in full to this client; or no client's any
 * more). '' for an entry that is not a share.
 */
export function splitShortNote(entry: ClockEntry, blocks: ReadonlyMap<string, SplitBlock>): string {
  if (!entry.groupId) return ''
  if (!entry.clientId) return 'Part of a shared block, now administrative time'
  if (blocks.get(entry.groupId)?.mode === 'full') return 'Billed in full to this client'
  return "This client's part of a shared block"
}

/** How far the time on the rows may sit from the clock time before the page says so (stamps and durations round a little). */
const CLOCK_TOLERANCE_MINUTES = 1

/**
 * Which way, if any, an entry's time on the report is not its clock time:
 *  - `typed`: an ordinary entry, or a full-mode share, whose minutes are not
 *    its stretches' total. Typing a duration is the one way an entry's time
 *    leaves its clock times, and the typed figure is what is billed and paid.
 *  - `parts`: a share of an even or custom split whose block's parts, added
 *    up, are not this entry's clock time. The parts are compared as a whole,
 *    since one is only part of the block; they stop adding up after an Adjust
 *    split that changes the total, a retyped part, time added to another part,
 *    or a part removed.
 * '' when they agree, when there are no clock times, and for a share whose
 * block is not known.
 */
function mismatchKind(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  clock: ClockSpans,
): { kind: '' | 'typed' | 'parts'; block?: SplitBlock } {
  if (clock.spans.length === 0) return { kind: '' as const, block: undefined }
  const block = entry.groupId ? blocks.get(entry.groupId) : undefined
  if (entry.groupId && !block) return { kind: '' as const, block: undefined }
  const carved = block !== undefined && block.mode !== 'full'
  const onTheRows = carved ? block.minutes : entry.minutes
  if (Math.abs(onTheRows - clock.clockMinutes) <= CLOCK_TOLERANCE_MINUTES) return { kind: '' as const, block: undefined }
  return { kind: carved ? ('parts' as const) : ('typed' as const), block }
}

/**
 * The line under the Hours of the entry's first row (and on every row of a
 * sheet), only when the time on the rows does not come from the clock times.
 * It is about the ENTRY, never "this row": a row is one stretch, and the sheets
 * repeat the line on every row.
 *  - "Hours typed in. This entry's stretches add up to 1h 55m on the clock."
 *  - "The clients' parts of this block do not add up to the time on the clock
 *    (39m)." ("The parts" once the parts no longer sit one per client.)
 */
export function clockMismatchNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  clock: ClockSpans,
): string {
  const { kind, block } = mismatchKind(entry, blocks, clock)
  if (!kind) return ''
  const clockTime = formatHoursMinutes(clock.clockMinutes)
  if (kind === 'typed') return `Hours typed in. This entry's stretches add up to ${clockTime} on the clock.`
  // The one part left of a block (its siblings deleted, or never more than
  // one): singular, and it does not say why, since nothing records it.
  if (block && block.shares === 1) {
    return `This part's ${formatHoursMinutes(entry.minutes)} is not the whole time on the clock (${clockTime}).`
  }
  const whose = block && block.clients > 1 && block.clients === block.shares ? "The clients' parts" : 'The parts'
  return `${whose} of this block do not add up to the time on the clock (${clockTime}).`
}

/** The short form under the Hours of every LATER row of a typed-hours entry; '' otherwise (a share's later rows carry `splitShortNote`). */
export function clockMismatchShortNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  clock: ClockSpans,
): string {
  return mismatchKind(entry, blocks, clock).kind === 'typed' ? 'Hours typed in for this entry' : ''
}

/**
 * How an entry's time got onto the timesheet, for the person approving payroll.
 *
 *  - `manual`: logged with "Log time manually" (the entry says so itself).
 *  - `timer_edited`: a timer entry whose clock times were edited after the
 *    timer ran (a stretch added, moved or removed), by the person or by an
 *    owner. Such an entry still says "timer"; nothing recorded the edit.
 *  - `timer`: clocked, and left as clocked.
 *  - `timer_unread`: a timer entry from before `CLOCK_EDITS_READABLE_FROM`
 *    whose clock times sit on exact minutes. They may have been edited, or only
 *    its note was; the data cannot say (see below). Nothing is said on screen,
 *    and a sheet says exactly that rather than "Timer".
 *  - `no_clock`: not a manual entry, and no clock times at all (older and
 *    imported time).
 *
 * `timer_edited` is READ OFF THE CLOCK TIMES, not stored: the timer records the
 * second (and millisecond) it started and stopped, while the entry's edit form
 * works in whole minutes, so a stretch that starts AND stops on an exact minute
 * went through the form. Checked against production on 2026-11-17: of the
 * 1,863 timer entries with clock times (they begin in June), every one is
 * either all seconds (1,514) or all exact minutes (349), and every manual
 * entry is on exact minutes; none mixes (the form saves every stretch
 * together; see below).
 * A timer stretch landing on an exact minute at both ends by chance is one in
 * billions. If the edit form ever takes seconds, this rule must become a stored
 * flag instead.
 *
 * ONLY STRETCHES FROM `CLOCK_EDITS_READABLE_FROM` ON ARE READ. Until commit
 * 93cdcecb (pushed 2026-08-05 18:32 UTC) the edit form sent the stretches on
 * EVERY save, so fixing a typo in the note, the client or the Billable box put
 * every clock time on whole minutes, with nobody touching one. For a stretch
 * older than that the data cannot tell a note edit from a time edit, so it is
 * never called edited (`timer_unread`). Since that commit the form sends the
 * stretches only when the stretch list itself was touched (`spansTouched` in
 * src/pages/TimePage.tsx; a test pins it, because this whole reading rests on
 * it). The date is set well after the commit on purpose: a browser tab loaded
 * before it kept the old form until it was reloaded, and nothing forced that.
 *
 * "Touched" is the form's word, not "changed": pressing Add time and removing
 * the row again, or retyping a time to the same minute, still saves every
 * stretch on whole minutes and so reads as edited. The clock times WERE
 * rewritten (their seconds are gone); the wording says "edited", never what
 * changed.
 *
 * THE MARK IS PER ENTRY, NEVER PER STRETCH, and says nothing of how much was
 * edited. Once anything in the edit form's stretch list is touched, the form
 * saves EVERY stretch from its whole-minute boxes (`handleSave` in
 * src/pages/TimePage.tsx), the untouched ones included, so their seconds are
 * gone too. That is why production has no mixed entries. Accepting the "Add
 * session" defaults on a three-hour clocked entry marks all of it. Do not build
 * "1 of 4 stretches typed" on this: the data cannot say it. And the wording
 * must not accuse: editing clock times is an ordinary, allowed thing, owners do
 * it to their own time and to others' at review, and nothing says who or when.
 */
export type HowLogged = 'manual' | 'timer_edited' | 'timer' | 'timer_unread' | 'no_clock'

const onTheMinute = (iso: string) => {
  const date = new Date(iso)
  return date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0
}

/**
 * The first moment whose stretches can be read for edits: the start of a day
 * (Eastern, the firm's) twelve days after the edit form stopped rewriting clock
 * times on every save, so that a tab still running the old form is not
 * plausible. `CLOCK_EDITS_READABLE_FROM_TEXT` is the same day in words.
 */
export const CLOCK_EDITS_READABLE_FROM = '2026-08-17T04:00:00.000Z'
export const CLOCK_EDITS_READABLE_FROM_TEXT = 'Aug 17, 2026'
const READABLE_FROM_MS = Date.parse(CLOCK_EDITS_READABLE_FROM)

export function howLogged(entry: Pick<TimeEntry, 'entryMethod'>, clock: ClockSpans): HowLogged {
  if (entry.entryMethod === 'manual') return 'manual'
  if (clock.spans.length === 0) return 'no_clock'
  const typed = (span: WorkSession) => onTheMinute(span.startAt) && onTheMinute(span.endAt)
  const readable = (span: WorkSession) => new Date(span.startAt).getTime() >= READABLE_FROM_MS
  if (clock.spans.some((span) => readable(span) && typed(span))) return 'timer_edited'
  // On exact minutes, from before the form could be trusted: not known either way.
  if (clock.spans.some((span) => !readable(span) && typed(span))) return 'timer_unread'
  return 'timer'
}

/**
 * The words for it as a method: a sheet's "Logged" column, the week review's
 * Method line. One verb, the app's own ("Edit"): "changed by hand" read as
 * "not genuine", and was wrong for a stretch added or removed.
 */
export const HOW_LOGGED_LABEL: Record<HowLogged, string> = {
  manual: 'Manual entry',
  timer_edited: 'Timer, clock times edited',
  timer: 'Timer',
  timer_unread: `Timer (before ${CLOCK_EDITS_READABLE_FROM_TEXT}: edits cannot be read)`,
  no_clock: 'Hours only (no clock times)',
}

/** The line under a row's Clock in: only where the clock times are not just what the timer recorded. */
export const HOW_LOGGED_NOTE: Record<HowLogged, string> = {
  manual: 'Manual entry',
  timer_edited: 'Clock times edited',
  timer: '',
  timer_unread: '',
  no_clock: '',
}

/**
 * The line under the Clock in of an entry's FIRST row on the payroll report.
 * The mark is known only for the whole entry, never for one stretch, so on an
 * entry worked in several stretches it says so ("Clock times edited (this
 * entry)") rather than reading as "this stretch was edited".
 */
export function howLoggedNote(logged: HowLogged, stretches: number): string {
  const note = HOW_LOGGED_NOTE[logged]
  return note && stretches > 1 ? `${note} (this entry)` : note
}

/** The chip on an approval row, and what hovering it says. */
export const CLOCK_TIMES_EDITED_CHIP = 'Clock times edited'
export const CLOCK_TIMES_EDITED_TITLE =
  'The clock times on this timer entry were edited after the timer ran, by the person or by an owner. Editing is allowed; this does not say who or when.'
