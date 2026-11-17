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
