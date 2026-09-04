import type { InvoiceDeliveryEvent, InvoiceEmailLogEntry } from '../lib/types'
import { latestInvoiceDelivery } from '../lib/utils'

/**
 * What the mail provider did with the invoice email, next to the record that it
 * was sent.
 *
 * Only ever shown when there is something to say. No delivery event at all —
 * an invoice sent before this existed, or one whose events have not arrived —
 * renders nothing, because an empty badge would read as a verdict.
 *
 * `sent` is deliberately silent too: it means the provider accepted the message,
 * which is exactly what the "Sent … to …" line beside it already says.
 */
const DELIVERY_LABELS: Record<InvoiceDeliveryEvent, string> = {
  sent: '',
  delivered: 'Delivered',
  delayed: 'Delayed',
  bounced: 'Bounced',
  complained: 'Marked as spam',
}

export function InvoiceDeliveryBadge({ emailLog }: { emailLog?: InvoiceEmailLogEntry[] }) {
  const delivery = latestInvoiceDelivery(emailLog)
  const label = delivery ? DELIVERY_LABELS[delivery.event] : ''
  if (!delivery || !label) return null
  // A bounce and a spam complaint are the two that need doing something about,
  // so they are the two that are allowed to be loud. Delivered stays quiet.
  const needsAction = delivery.event === 'bounced' || delivery.event === 'complained'
  return (
    <span
      className={needsAction ? 'invoice-delivery-badge is-bad' : 'invoice-delivery-badge'}
      title={delivery.detail || undefined}
    >
      {label}
    </span>
  )
}
