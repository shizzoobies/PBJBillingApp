/**
 * The billing-period send guard's question, as one block: the server's sentence and,
 * for the one reason that may be overridden, a button that repeats the action with
 * the owner's yes. Shared by the month run and the lower Email view so the two never
 * say it differently. It never decides anything; the server re-derives the hold on
 * every request.
 */
export function PrepaymentHoldNotice({
  message,
  canOverride,
  overrideLabel,
  busy,
  onOverride,
  onDismiss,
}: {
  message: string
  canOverride: boolean
  /** "Send anyway", or "Mark reviewed anyway" where the action stamps the invoice sent. */
  overrideLabel: string
  busy: boolean
  onOverride: () => void
  onDismiss: () => void
}) {
  return (
    <div className="invoice-run-error invoice-run-prepayment-ask" role="alert">
      <p>{message}</p>
      {canOverride ? (
        <>
          <button type="button" className="secondary-action" disabled={busy} onClick={onOverride}>
            {overrideLabel}
          </button>{' '}
        </>
      ) : null}
      <button type="button" className="link-button" onClick={onDismiss}>
        {canOverride ? 'Not now' : 'OK'}
      </button>
    </div>
  )
}
