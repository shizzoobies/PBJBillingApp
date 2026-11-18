import type { TimeEntry, WorkSession } from './types'
import { effectiveSessions, formatHoursMinutes, sessionMinutes } from './utils'

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
 * The line under a share's Hours. It says the share's OWN time first ("13m
 * share ..."), because that is the figure its Hours are: 13 minutes is 0.22h,
 * rounded like every other row, so three such rows add to 0.66h on the report
 * though the shares total 39 minutes.
 *
 * `forExport` adds, for a full-mode share, that its hours count once: the
 * screen says that on the repeated rows themselves.
 */
export function splitNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  { forExport = false }: { forExport?: boolean } = {},
): string {
  if (!entry.groupId) return ''
  const block = blocks.get(entry.groupId)
  if (!block) return 'share of a block split across clients'
  const own = formatHoursMinutes(entry.minutes)
  // Moved off its client since the split: it is no longer anyone's share to bill.
  if (!entry.clientId) return `${own} share of a split block, moved to administrative time`
  if (block.shares === 1) return `${own}, the one remaining share of a split block`
  // Shares that no longer sit on different clients are counted as shares.
  const spread = block.clients > 1 ? count(block.clients, 'client') : count(block.shares, 'share')
  if (block.mode === 'full') {
    const once = forExport ? '; hours counted once' : ''
    // Every share repeats the block. Once one share was changed on its own,
    // only this row's own time can be stated.
    return block.uniform && block.clients === block.shares
      ? `full ${own} block billed to each of ${spread}${once}`
      : `${own} billed in full to this client, one of ${count(block.shares, 'share')} of one block${once}`
  }
  return `${own} share of a block split ${block.clients > 1 ? 'across' : 'into'} ${spread} (the shares total ${formatHoursMinutes(block.minutes)})`
}

/** How far the time on the rows may sit from the clock time before the page says so (stamps and durations round a little). */
const CLOCK_TOLERANCE_MINUTES = 1

/**
 * The second line under Hours, only when the time on the row does not come
 * from its clock times:
 *  - an ordinary entry, or a full-mode share: "Hours typed in (clock time 1h
 *    55m)". Typing a duration is the one way an entry's time leaves its clock
 *    times, and the typed figure is what is billed and paid.
 *  - a share of an even or custom split: "The shares do not add up to this
 *    row's clock time (39m)". The shares are compared as a whole, since one
 *    share is only part of the block; they stop adding up after an Adjust
 *    split that changes the total, a retyped share, time added to another
 *    share, or a share removed.
 * '' when they agree, when there are no clock times, and for a share whose
 * block is not known.
 */
export function clockMismatchNote(
  entry: ClockEntry,
  blocks: ReadonlyMap<string, SplitBlock>,
  clock: ClockSpans,
): string {
  if (clock.spans.length === 0) return ''
  const block = entry.groupId ? blocks.get(entry.groupId) : undefined
  if (entry.groupId && !block) return ''
  const carved = block !== undefined && block.mode !== 'full'
  const onTheRows = carved ? block.minutes : entry.minutes
  if (Math.abs(onTheRows - clock.clockMinutes) <= CLOCK_TOLERANCE_MINUTES) return ''
  const clockTime = formatHoursMinutes(clock.clockMinutes)
  return carved
    ? `The shares do not add up to this row's clock time (${clockTime})`
    : `Hours typed in (clock time ${clockTime})`
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

/** The chip on an approval row, and what hovering it says. */
export const CLOCK_TIMES_EDITED_CHIP = 'Clock times edited'
export const CLOCK_TIMES_EDITED_TITLE =
  'The clock times on this timer entry were edited after the timer ran, by the person or by an owner. Editing is allowed; this does not say who or when.'
