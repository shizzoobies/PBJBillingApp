import { useEffect, useState } from 'react'
import {
  addAccountCreditRequest,
  listAccountCreditsRequest,
  voidAccountCreditRequest,
} from '../lib/api'
import type { AccountCredit } from '../lib/types'
import {
  accountCreditDrawText,
  accountCreditMonth,
  accountCreditSourceText,
} from '../lib/accountCreditText'
import { autopayDate } from '../lib/autopayText'
import { currency } from '../lib/utils'

// The same ceilings the server enforces.
const MAX_AMOUNT = 1_000_000
const MAX_NOTE = 500

/**
 * Credit on account, on a client's Billing tab (featreq-110efd15, stage 1a):
 * money the client has paid ahead or paid twice, held for a future invoice. A
 * balance, a form to record a credit by hand, and the ledger with a Void on each
 * live row.
 *
 * OWNER-ONLY by where it is mounted (the Billing tab is owner-only) and by the
 * endpoints behind it. The ledger lists what each credit has been drawn on
 * (stage 1b: the owner applies a credit from the invoice's own editor; nothing
 * here touches an invoice). A company billed on a master's combined invoice has
 * no credit of its own - the master is the one that pays - so for a sub the
 * panel is one line and fetches nothing.
 */
export function AccountCreditPanel({
  clientId,
  billedOnMaster = false,
  masterName = null,
  retired = false,
  clientName = null,
}: {
  clientId: string
  /** This client is a billing sub: its credit lives on the master. */
  billedOnMaster?: boolean
  masterName?: string | null
  /** A retired client takes no new credit; what is on file still shows. */
  retired?: boolean
  clientName?: string | null
}) {
  if (billedOnMaster) {
    return (
      <p className="account-credit-help" data-testid="account-credit-sub-note">
        {masterName
          ? `This company is billed on ${masterName}’s combined invoice, so credit on account lives on that master.`
          : 'This company is billed on its master’s combined invoice, so credit on account lives on that master.'}{' '}
        Open the master’s Billing tab to see or add it.
      </p>
    )
  }
  return <AccountCreditLedger key={clientId} clientId={clientId} retiredName={retired ? clientName || 'That client' : null} />
}

function AccountCreditLedger({ clientId, retiredName }: { clientId: string; retiredName: string | null }) {
  const [state, setState] = useState<{ balance: number; credits: AccountCredit[] } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [forPeriod, setForPeriod] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bumped after an add or a void so the list is read again from the server.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((n) => n + 1)

  useEffect(() => {
    // The caller keys this by client, so another client is a fresh mount rather
    // than this one being talked into showing someone else's balance.
    let stale = false
    listAccountCreditsRequest(clientId).then(
      (listed) => {
        if (stale) return
        setState(listed)
        setLoadFailed(false)
      },
      () => {
        if (!stale) setLoadFailed(true)
      },
    )
    return () => {
      stale = true
    }
  }, [clientId, reloadKey])

  const value = Number(amount)
  const validAmount = amount.trim() !== '' && Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT

  const add = async () => {
    if (!validAmount || busy || retiredName) return
    setBusy(true)
    setError(null)
    try {
      await addAccountCreditRequest(clientId, {
        amount: value,
        note: note.trim(),
        forPeriod: forPeriod || null,
      })
      setAmount('')
      setNote('')
      setForPeriod('')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the credit. Nothing was saved.')
    } finally {
      setBusy(false)
    }
  }

  const voidCredit = async (credit: AccountCredit) => {
    if (
      !window.confirm(
        `Void this ${currency.format(credit.amount)} credit? It stops counting toward the balance and stays in the list, struck through.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await voidAccountCreditRequest(credit.id)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not void the credit. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  if (state === null) {
    return loadFailed ? (
      <p className="invoice-run-error" role="alert">
        Could not load credit on account.{' '}
        <button type="button" className="link-button" onClick={reload}>
          Try again
        </button>
      </p>
    ) : (
      <p className="account-credit-help">Loading credit on account…</p>
    )
  }

  return (
    <div className="account-credit">
      {loadFailed ? (
        <p className="invoice-run-error" role="alert">
          Could not refresh the list, so this may be out of date.{' '}
          <button type="button" className="link-button" onClick={reload}>
            Try again
          </button>
        </p>
      ) : null}
      <div role="group" aria-label="Credit on account balance" className="account-credit-balance">
        <span className="account-credit-balance-label">Balance</span>
        <strong data-testid="account-credit-balance">{currency.format(state.balance)}</strong>
      </div>
      <p className="account-credit-help">
        Money the client has paid ahead, or paid twice, held for a future invoice. Apply it from the
        invoice: open a draft or reviewed invoice and press Apply credit on account.
      </p>

      <div className="form-grid two-col">
        <label className="field">
          <span>Amount</span>
          <input
            className="input"
            type="number"
            min="0"
            max={MAX_AMOUNT}
            step="0.01"
            value={amount}
            placeholder="0.00"
            disabled={busy || Boolean(retiredName)}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Reason</span>
          <input
            className="input"
            value={note}
            maxLength={MAX_NOTE}
            placeholder="Why the client has credit"
            disabled={busy || Boolean(retiredName)}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Month it is meant for (optional)</span>
          <input
            className="input"
            type="month"
            value={forPeriod}
            disabled={busy || Boolean(retiredName)}
            onChange={(event) => setForPeriod(event.target.value)}
          />
        </label>
      </div>
      {retiredName ? (
        <p className="account-credit-help" data-testid="account-credit-retired-note">
          {retiredName} is retired, so credit cannot be added to them. Reactivate them first.
        </p>
      ) : null}
      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="account-credit-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={busy || !validAmount || Boolean(retiredName)}
          title={validAmount ? undefined : 'Enter an amount first'}
          onClick={() => void add()}
        >
          Add credit
        </button>
      </div>

      {state.credits.length === 0 ? (
        <p className="account-credit-help">Nothing on account yet.</p>
      ) : (
        <div className="account-credit-scroll">
          <table className="account-credit-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Amount</th>
                <th scope="col">Source</th>
                <th scope="col">Meant for</th>
                <th scope="col">Reason</th>
                <th scope="col">Used on</th>
                <th scope="col">Remaining</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.credits.map((credit) => {
                const isVoid = Boolean(credit.voidedAt)
                return (
                  <tr key={credit.id} className={isVoid ? 'is-void' : undefined}>
                    <td>{autopayDate(credit.createdAt)}</td>
                    <td>{currency.format(credit.amount)}</td>
                    <td>{accountCreditSourceText(credit)}</td>
                    <td>{credit.forPeriod ? accountCreditMonth(credit.forPeriod) : '—'}</td>
                    <td>{credit.derived ? '—' : credit.note || '—'}</td>
                    <td>
                      {credit.draws.length === 0 ? (
                        '—'
                      ) : (
                        <ul className="account-credit-draws">
                          {credit.draws.map((draw) => (
                            <li key={draw.invoiceId}>{accountCreditDrawText(draw)}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{isVoid ? '—' : currency.format(credit.remaining)}</td>
                    <td>
                      {isVoid ? (
                        <span className="account-credit-void-flag">Void</span>
                      ) : credit.derived ? (
                        // Derived from a paid invoice: there is no row to void (void the invoice).
                        <span className="account-credit-help">From a paid invoice</span>
                      ) : (
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() => void voidCredit(credit)}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
