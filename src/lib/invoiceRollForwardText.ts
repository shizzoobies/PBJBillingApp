/**
 * What the month run SAYS after Push to next month, its undo, and a Generate that
 * carried pushed lines (featreq-40697310). Every branch is a sentence she reads
 * after a click, so it lives here with its own test rather than inside the page.
 */
import type {
  InvoiceAdvanceCarriedReport,
  InvoiceCarriedReport,
  InvoiceRollForwardResult,
  InvoiceUndoRollForwardResult,
} from './api'
import { getBillingPeriodLabel } from './utils'
import { generateSkipMessage } from './invoiceSkipMessage'

const isPeriod = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)

/** One advance report as a sentence, or '' when there is nothing to say. */
function advanceSentence(advance: InvoiceAdvanceCarriedReport | null | undefined) {
  if (!advance) return ''
  const name = advance.number ? `The advance request ${advance.number}` : 'The advance request'
  if (advance.attached) return ` ${name} moved with it.`
  return advance.message ? ` ${name} was not moved: ${advance.message}` : ` ${name} was not moved.`
}

/** After a push: where the lines went, and what happened to an advance. */
export function rollForwardNotice(
  result: InvoiceRollForwardResult,
  fallback: { number: string | null; period: string },
) {
  const name = result.rolled?.number ?? fallback.number ?? 'This invoice'
  const into = result.rolled?.rolledIntoPeriod
  const toLabel = isPeriod(into) ? getBillingPeriodLabel(into) : 'next month'
  const where = result.carrier
    ? ` Its lines are now on ${result.carrier.number ?? `${toLabel}'s invoice`}.`
    : ` Its lines go onto ${toLabel}'s invoice when you generate ${toLabel}.`
  return `${name} was pushed into ${toLabel}.${where}${advanceSentence(result.advance)}`
}

/** After an undo: what came off where, and what was built again. */
export function undoRollForwardNotice(
  result: InvoiceUndoRollForwardResult,
  fallback: { number: string | null; period: string; clientName: string },
) {
  const name = result.rolled?.number ?? fallback.number ?? 'this invoice'
  const periodLabel = getBillingPeriodLabel(fallback.period)
  let text = `The push of ${name} was undone.`
  if (result.carrier) {
    text += result.carrierVoided
      ? ` ${result.carrier.number ?? 'The next month’s invoice'} held nothing else, so it was voided.`
      : ` Its lines were taken off ${result.carrier.number ?? 'the next month’s invoice'}.`
  }
  if (result.generateError) {
    text += ` ${result.generateError}`
  } else if (result.regenerated) {
    text += ` ${periodLabel} was built again as ${result.regenerated.number ?? 'a new draft'}.`
  } else {
    text += ` ${generateSkipMessage(result.skipped?.[0], fallback.clientName, periodLabel)}`
  }
  return text + advanceSentence(result.advance)
}

/**
 * The extra words a Generate (or Void & regenerate) result earns when pushed
 * invoices were involved: clients skipped because their month was pushed, drafts
 * that took pushed lines, and any advance that could not move. '' when none.
 */
export function generateRollForwardNote(result: {
  skipped?: Array<{ reason?: string }>
  carried?: InvoiceCarriedReport[]
  advances?: InvoiceAdvanceCarriedReport[]
}) {
  const pushedOut = (result.skipped ?? []).filter((row) => row.reason === 'rolled-forward').length
  const carried = (result.carried ?? []).length
  const stuck = (result.advances ?? []).filter((row) => !row.attached)
  let text = ''
  if (carried > 0) {
    text += ` ${carried} invoice${carried === 1 ? '' : 's'} carried lines pushed from last month.`
  }
  if (pushedOut > 0) {
    text += ` ${pushedOut} client${pushedOut === 1 ? '' : 's'} pushed to next month, so not billed here.`
  }
  for (const row of stuck) text += advanceSentence(row)
  return text
}
