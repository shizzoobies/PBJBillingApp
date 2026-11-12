import { useEffect, useRef, useState } from 'react'
import { formatProposalMoney, isNoChargeLine } from '../../../lib/proposal-pricing.js'
import {
  SPLIT_LEAVE_ONE,
  splitLineTotals,
  splitTotalsWords,
} from '../../../lib/proposal-split.js'
import type { PricedLine, Proposal } from '../../lib/types'

/** A line's name as the Estimate tab prints it: "Monthly transactions (Basic)". */
function lineName(line: PricedLine): string {
  return line.tier ? `${line.name} (${line.tier})` : line.name
}

/** A line's amount by the Estimate tab's rule: never $0.00 for a line with no price yet. */
function lineAmount(line: PricedLine): string {
  if (isNoChargeLine(line)) return 'No charge'
  return line.amount > 0 ? formatProposalMoney(line.amount) : 'Not yet priced'
}

/**
 * "Split" on a Draft or Sent proposal (featreq-23b26bb1): tick the lines to move
 * to a new draft proposal; the lines left unticked stay here. Shows what each
 * part comes to before anything is saved. The server does the move in one write
 * and prices both parts; this dialog only chooses the lines.
 */
export function SplitProposalDialog({
  proposal,
  busy,
  onCancel,
  onSplit,
}: {
  proposal: Proposal
  busy: boolean
  onCancel: () => void
  onSplit: (serviceIds: string[]) => void
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  // Escape closes it, and focus starts inside it, like the app's other dialogs.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef(onCancel)
  useEffect(() => {
    cancelRef.current = onCancel
  }, [onCancel])
  useEffect(() => {
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  // Only lines that are still selections can move; the snapshot is what the server priced.
  const selected = new Set(proposal.selections.map((entry) => entry.serviceId))
  const lines = (proposal.pricingSnapshot?.lines ?? []).filter(
    (line): line is PricedLine & { serviceId: string } =>
      typeof line.serviceId === 'string' && selected.has(line.serviceId),
  )
  const moving = lines.filter((line) => picked.has(line.serviceId))
  const staying = lines.filter((line) => !picked.has(line.serviceId))
  const everything = lines.length > 0 && staying.length === 0
  const canSplit = moving.length > 0 && staying.length > 0

  const toggle = (serviceId: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current)
      if (on) next.add(serviceId)
      else next.delete(serviceId)
      return next
    })

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Split this proposal"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="modal-body">
          <h2 className="modal-title">Split this proposal</h2>
          <p className="modal-intro">
            Tick the lines to move to a new draft proposal. The lines you leave unticked stay on this one. Both keep
            the prospect and the counts, each can be accepted on its own, and nothing is emailed.
          </p>
          {proposal.letter ? (
            <p className="muted-text" data-testid="split-letter-note">
              {proposal.status === 'sent'
                ? 'The letter already sent lists every line. Draft the letter again on the Letter tab before you send this proposal again.'
                : 'The letter on this proposal was written for every line. Draft it again on the Letter tab after the split.'}
            </p>
          ) : null}

          <div className="table-wrap">
            <table className="report-table proposal-lines">
              <tbody>
                {lines.map((line) => {
                  const label = `${line.group ?? 'Retired'}: ${lineName(line)}`
                  return (
                    <tr key={line.serviceId}>
                      <td>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            aria-label={`Move ${label}`}
                            checked={picked.has(line.serviceId)}
                            disabled={busy}
                            onChange={(event) => toggle(line.serviceId, event.target.checked)}
                          />
                          <span>
                            <strong>{lineName(line)}</strong>
                            <span className="muted-text">{` · ${line.group ?? 'Retired'}`}</span>
                          </span>
                        </label>
                      </td>
                      <td className="proposal-line-amount">{lineAmount(line)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div aria-live="polite">
          <p data-testid="split-stays">
            <strong>Stays on this proposal:</strong>{' '}
            {staying.length === 0
              ? 'nothing'
              : `${staying.length} ${staying.length === 1 ? 'line' : 'lines'} · ${splitTotalsWords(splitLineTotals(staying))}`}
          </p>
          <p data-testid="split-moves">
            <strong>Moves to the new proposal:</strong>{' '}
            {moving.length === 0
              ? 'nothing yet'
              : `${moving.length} ${moving.length === 1 ? 'line' : 'lines'} · ${splitTotalsWords(splitLineTotals(moving))}`}
          </p>
          </div>
          {everything ? (
            <p className="form-error" role="alert">
              {SPLIT_LEAVE_ONE}
            </p>
          ) : null}

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={busy || !canSplit}
              onClick={() => onSplit(moving.map((line) => line.serviceId))}
            >
              {moving.length === 0
                ? 'Split'
                : `Split off ${moving.length} ${moving.length === 1 ? 'line' : 'lines'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
