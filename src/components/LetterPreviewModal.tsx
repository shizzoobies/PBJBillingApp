import { letterPreviewPdfUrl, previewLetterRequest } from '../lib/api'
import type { LetterPreview } from '../lib/types'
import { retiredSentence } from '../../lib/letter-template.js'
import { DocumentPreviewModal } from './letters/DocumentPreviewModal'
import { unknownPreviewNotes } from './letters/letterEditing'

/** The sentences under the title: who it goes to, what is missing, what would make Send skip them. */
function letterNotes(preview: LetterPreview): string[] {
  const notes: string[] = []
  if (preview.to.length > 0) {
    notes.push(`To: ${preview.to.join(', ')}`)
  } else {
    notes.push(preview.refusal ?? 'No email address on file, so Send would skip this client.')
  }
  if (preview.missing.length > 0) {
    notes.push(
      `Missing for this client: ${preview.missing.map((key) => `{{${key}}}`).join(', ')}. Send skips this client.`,
    )
    if (preview.missingNote) notes.push(preview.missingNote)
  }
  notes.push(...unknownPreviewNotes(preview.unknown))
  if (preview.retired.length > 0) {
    notes.push(`${retiredSentence(preview.retired)}. Send refuses until it is taken out.`)
  }
  if (preview.flags.neverEmailed) {
    notes.push('This client is set to never have invoices emailed. A letter is not an invoice, so it still goes.')
  }
  if (preview.flags.billedOutside) {
    notes.push('This client is invoiced outside the app. A letter is not an invoice, so it still goes.')
  }
  if (preview.flags.billingMasterSub) {
    notes.push(`This client is billed through ${preview.flags.billingMasterSub}.`)
  }
  if (preview.batchNote) notes.push(`${preview.batchNote} Send skips this client.`)
  if (!preview.pdfAvailable) {
    notes.push('The PDF could not be built, so Send would skip this client.')
  }
  return notes
}

/**
 * Preview: exactly what one client receives for a saved letter (featreq-5e195707).
 *
 * The server builds the email and the PDF from the STORED letter with the SAME
 * code Send uses, so this is the real two, shown before anything goes out. The
 * window itself is the shared DocumentPreviewModal.
 */
export function LetterPreviewModal({
  letterId,
  clientId,
  clientName,
  batchIds,
  onClose,
}: {
  letterId: string
  clientId: string
  clientName: string
  /** The clients ticked together with this one: the preview says when a billing master's letter covers it. */
  batchIds?: string[]
  onClose: () => void
}) {
  return (
    <DocumentPreviewModal<LetterPreview>
      loadKey={`${letterId}|${clientId}`}
      load={() => previewLetterRequest(letterId, clientId, batchIds)}
      pdfUrl={letterPreviewPdfUrl(letterId, clientId)}
      title={`What ${clientName} receives`}
      ariaLabel={`Preview of the letter for ${clientName}`}
      notes={letterNotes}
      onClose={onClose}
    />
  )
}
