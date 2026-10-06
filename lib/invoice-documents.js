import { buildInvoiceEmail } from './invoice-email.js'
import { buildInvoicePdf, invoicePdfFilename } from './invoice-pdf.js'

/**
 * The two documents a client receives for an invoice - the email and the PDF
 * that rides along - built in ONE place (featreq-459bdfc2 item 3).
 *
 * The send route and the preview route both call this with the same inputs
 * (the invoice as it will be stored once sent, the invoice's client, the
 * firm's settings, the pay links and any autopay plan), so what the owner
 * previews is what the send builds by construction rather than by a second
 * renderer kept in step by hand. Anything the client-facing documents need
 * from the client record - the per-client footer note, the firm's name on the
 * subject line - is resolved here, once.
 *
 * The PDF is best-effort on purpose: the email is the payment vehicle and the
 * PDF is a nicety, so a rendering failure yields the email with `pdf: null`
 * and the error in `pdfError` rather than throwing. The send logs it and goes
 * without the attachment; the preview says so.
 *
 * @param {object} args
 * @param {object} args.invoice   the STORED invoice, already passed through `invoiceAsSent`
 * @param {object} args.client    the invoice's own client (a billing master's invoice carries the master)
 * @param {object|null} [args.firmSettings]
 * @param {string} [args.payUrl]
 * @param {string} [args.cardPayUrl]
 * @param {object|null} [args.autopay]  see `buildInvoiceEmail`
 * @param {typeof buildInvoicePdf} [args.buildPdf]  injectable for tests
 * @returns {Promise<{email: {subject: string, html: string, text: string}, pdf: Buffer|null, pdfFilename: string, pdfError: Error|null}>}
 */
export async function buildInvoiceDocuments({
  invoice,
  client,
  firmSettings = null,
  payUrl = '',
  cardPayUrl = '',
  autopay = null,
  buildPdf = buildInvoicePdf,
}) {
  const email = buildInvoiceEmail({
    invoice,
    client,
    payUrl,
    cardPayUrl,
    autopay,
    // The same per-client note the printed sheet and the PDF carry.
    footerNote: client?.footerNote ?? '',
    // The firm's own name, so the client sees who is billing them rather than
    // the builder's default; the builder's default is the fallback.
    firmName: firmSettings?.name || undefined,
    firmSettings,
  })
  let pdf = null
  let pdfError = null
  try {
    pdf = await buildPdf({ invoice, client, firmSettings })
  } catch (error) {
    pdfError = error instanceof Error ? error : new Error(String(error))
  }
  return { email, pdf, pdfFilename: invoicePdfFilename(invoice), pdfError }
}
