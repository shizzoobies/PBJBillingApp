import { describe, expect, it } from 'vitest'
import {
  allocateByPercentages,
  minutesToSeconds,
  percentagesFromMinutes,
  percentagesTotalTo100,
} from './group-allocation.js'

/**
 * Splitting BY PERCENTAGE — "give Acme 60% and Bright Books 40%" instead of
 * making the owner work out that 60% of a 47m 20s block is 28m 24s.
 *
 * The one promise that matters: when the percentages total 100, the minutes
 * handed back add up to EXACTLY the block, to the second. The server rejects a
 * custom split that doesn't (that is how a percentage split is saved — the
 * percentages are an input method, not a stored mode), so a fraction of a second
 * lost here is a 400 in her face.
 */

const seconds = (result) =>
  Object.fromEntries(Object.entries(result).map(([id, minutes]) => [id, minutesToSeconds(minutes)]))

const totalSeconds = (result) =>
  Object.values(result).reduce((sum, minutes) => sum + minutesToSeconds(minutes), 0)

describe('allocateByPercentages', () => {
  it('divides by the percentages given', () => {
    expect(allocateByPercentages(60, { a: 60, b: 40 })).toEqual({ a: 36, b: 24 })
  })

  it('accounts for every second of an awkward block — 33.33 / 33.33 / 33.34', () => {
    // 60m = 3600s. Thirds do not divide the percentages OR the seconds cleanly.
    const result = allocateByPercentages(60, { a: 33.33, b: 33.33, c: 33.34 })
    expect(totalSeconds(result)).toBe(3600)
    // 1199.88 / 1199.88 / 1200.24 → floors leave 2 seconds, and the two largest
    // remainders (.88) take one each. Nobody notices; the block is whole.
    expect(seconds(result)).toEqual({ a: 1200, b: 1200, c: 1200 })
  })

  it('accounts for every second of a block that is one second odd', () => {
    // 45m 1s = 2701s: 50/25/25 lands on .5 and .25 of a second three times over.
    const block = 2701 / 60
    const result = allocateByPercentages(block, { a: 50, b: 25, c: 25 })
    expect(totalSeconds(result)).toBe(2701)
    // 1350.5 / 675.25 / 675.25 → floors 1350 / 675 / 675 = 2700, one second left,
    // and the largest remainder (.5) has it.
    expect(seconds(result)).toEqual({ a: 1351, b: 675, c: 675 })
  })

  it('accounts for every second of a fractional total — 45m 20s', () => {
    const block = 45 + 20 / 60
    const result = allocateByPercentages(block, { a: 33.33, b: 33.33, c: 33.34 })
    expect(totalSeconds(result)).toBe(2720)
  })

  it('never loses or invents a second across a pile of awkward cases', () => {
    const blocks = [1 / 60, 7 / 60, 0.5, 1, 12.75, 45 + 20 / 60, 47 + 47 / 60, 60, 481 + 1 / 60]
    const percentSets = [
      { a: 100 },
      { a: 50, b: 50 },
      { a: 70, b: 30 },
      { a: 33.33, b: 33.33, c: 33.34 },
      { a: 12.5, b: 12.5, c: 25, d: 50 },
      { a: 0.01, b: 99.99 },
      { a: 16.67, b: 16.67, c: 16.66, d: 16.67, e: 16.67, f: 16.66 },
    ]
    for (const block of blocks) {
      for (const percents of percentSets) {
        const result = allocateByPercentages(block, percents)
        expect(totalSeconds(result)).toBe(minutesToSeconds(block))
      }
    }
  })

  it('hands the leftover seconds to the LARGEST remainders, deterministically', () => {
    // 10s across 33.33 / 33.33 / 33.34 → 3.333 / 3.333 / 3.334 seconds. One
    // second is left over and it goes to c, not to whoever is listed first.
    const result = allocateByPercentages(10 / 60, { a: 33.33, b: 33.33, c: 33.34 })
    expect(seconds(result)).toEqual({ a: 3, b: 3, c: 4 })
    // Same input, same answer — every time.
    expect(allocateByPercentages(10 / 60, { a: 33.33, b: 33.33, c: 33.34 })).toEqual(result)
  })

  it('breaks a tie by the order the clients are listed in', () => {
    // 5s at 50/50 is 2.5s each: the tie goes to the first client on screen.
    expect(seconds(allocateByPercentages(5 / 60, { a: 50, b: 50 }))).toEqual({ a: 3, b: 2 })
    expect(seconds(allocateByPercentages(5 / 60, { b: 50, a: 50 }))).toEqual({ b: 3, a: 2 })
  })

  it('is honest when the percentages do not add up — it does not stretch them', () => {
    // The caller blocks this (submit is disabled); if it ever gets through, the
    // result is visibly short rather than quietly inflated to fill the block.
    expect(totalSeconds(allocateByPercentages(60, { a: 50, b: 25 }))).toBe(2700)
    expect(totalSeconds(allocateByPercentages(60, { a: 80, b: 40 }))).toBe(4320)
  })

  it('treats missing, negative and unusable percentages as 0', () => {
    expect(allocateByPercentages(60, { a: 100, b: -20, c: Number.NaN, d: undefined })).toEqual({
      a: 60,
      b: 0,
      c: 0,
      d: 0,
    })
  })

  it('returns nothing for no clients, and nothing for a zero block', () => {
    expect(allocateByPercentages(60, {})).toEqual({})
    expect(allocateByPercentages(0, { a: 50, b: 50 })).toEqual({ a: 0, b: 0 })
  })
})

describe('percentagesTotalTo100', () => {
  it('accepts an exact 100 however it is spelled', () => {
    expect(percentagesTotalTo100({ a: 100 })).toBe(true)
    expect(percentagesTotalTo100({ a: 60, b: 40 })).toBe(true)
    expect(percentagesTotalTo100({ a: 33.33, b: 33.33, c: 33.34 })).toBe(true)
    // 0.1 + 0.2 arithmetic: six 16.66/16.67 shares must not fail on binary dust.
    expect(
      percentagesTotalTo100({ a: 16.67, b: 16.67, c: 16.66, d: 16.67, e: 16.67, f: 16.66 }),
    ).toBe(true)
  })

  it('tolerates float dust but not a real gap', () => {
    expect(percentagesTotalTo100({ a: 99.99995, b: 0 })).toBe(true)
    expect(percentagesTotalTo100({ a: 100.00005 })).toBe(true)
    expect(percentagesTotalTo100({ a: 99.999 })).toBe(false)
    expect(percentagesTotalTo100({ a: 95, b: 4 })).toBe(false)
    expect(percentagesTotalTo100({ a: 60, b: 50 })).toBe(false)
  })

  it('ignores entries that are not numbers, so a blank box is not 100', () => {
    expect(percentagesTotalTo100({ a: 100, b: Number.NaN })).toBe(true)
    expect(percentagesTotalTo100({ a: 50, b: Number.NaN })).toBe(false)
    expect(percentagesTotalTo100({})).toBe(false)
  })
})

describe('percentagesFromMinutes', () => {
  it('reads the percentages back off an existing split', () => {
    expect(percentagesFromMinutes({ a: 36, b: 24 }, 60)).toEqual({ a: 60, b: 40 })
  })

  it('adjusts to 2dp so the numbers on screen add up to 100', () => {
    // A plain round would show 33.33 three times — 99.99, which the caller's own
    // 100% check would then refuse.
    const thirds = percentagesFromMinutes({ a: 20, b: 20, c: 20 }, 60)
    expect(thirds).toEqual({ a: 33.34, b: 33.33, c: 33.33 })
    expect(percentagesTotalTo100(thirds)).toBe(true)
  })

  it('round-trips: percentages off a split rebuild that same split', () => {
    for (const [allocations, total] of [
      [{ a: 36, b: 24 }, 60],
      [{ a: 20, b: 20, c: 20 }, 60],
      [{ a: 1200 / 60, b: 1199 / 60, c: 1201 / 60 }, 60],
      [{ a: 907 / 60, b: 907 / 60, c: 906 / 60 }, 2720 / 60],
    ]) {
      const percents = percentagesFromMinutes(allocations, total)
      expect(percentagesTotalTo100(percents)).toBe(true)
      const rebuilt = allocateByPercentages(total, percents)
      expect(totalSeconds(rebuilt)).toBe(minutesToSeconds(total))
      for (const id of Object.keys(allocations)) {
        // 2dp of a percent is worth well under a second on these blocks.
        expect(Math.abs(minutesToSeconds(rebuilt[id]) - minutesToSeconds(allocations[id]))).toBeLessThanOrEqual(1)
      }
    }
  })

  it('falls back to an even share when there are no minutes to go on', () => {
    const even = percentagesFromMinutes({ a: 0, b: 0, c: 0 }, 0)
    expect(even).toEqual({ a: 33.34, b: 33.33, c: 33.33 })
    expect(percentagesTotalTo100(even)).toBe(true)
  })

  it('returns nothing for no clients', () => {
    expect(percentagesFromMinutes({}, 60)).toEqual({})
  })
})
