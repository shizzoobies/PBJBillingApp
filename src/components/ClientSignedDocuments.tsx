import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { engagementEsignPdfUrl, listClientSignedDocuments } from '../lib/api'
import { ENGAGEMENT_KIND_LABELS, ENGAGEMENT_STATUS_LABELS, engagementInstantLabel } from '../lib/engagements'
import type { ClientSignedDocument } from '../lib/types'

/**
 * Signed documents on a client's page (featreq-d4548b2c). Brittany: "Each
 * client's folder should have a Documents area that lists all documents that
 * client has signed, including engagement letters ... When a document is
 * signed, its saved PDF should automatically appear ... Only signed, saved PDFs
 * should appear here."
 *
 * The list is every letter of this client that was signed through Send for
 * signature and whose signed PDF is kept (the original, amendments, a
 * superseding letter), newest first, each with its PDF to download. Nothing is uploaded or copied: it is
 * read off the engagements, so a newly signed letter is here the next time the
 * page reads (and at once when the app says data changed). The same PDF is
 * still on the letter itself (Engagements, Download signed PDF).
 *
 * Owner only, like the letters themselves; the page renders this for owners.
 */
export function ClientSignedDocuments({
  clientId,
  refreshKey = 0,
}: {
  clientId: string
  /** Changes when another tab or session changed data (the list is read again). */
  refreshKey?: number
}) {
  const [loaded, setLoaded] = useState<{
    clientId: string
    documents: ClientSignedDocument[]
    signedWithoutPdf: number
  } | null>(null)
  const [failed, setFailed] = useState<{ clientId: string; message: string } | null>(null)

  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const result = await listClientSignedDocuments(clientId)
        if (!live) return
        setLoaded({ clientId, ...result })
        setFailed(null)
      } catch (error) {
        if (!live) return
        setFailed({
          clientId,
          message: error instanceof Error && error.message ? error.message : 'Could not read the signed documents.',
        })
      }
    }
    void read()
    return () => {
      live = false
    }
  }, [clientId, refreshKey])

  // Never another client's documents under this client.
  const list = loaded?.clientId === clientId ? loaded : null
  const error = failed?.clientId === clientId ? failed.message : ''

  return (
    <div className="client-signed-documents">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!list && !error ? <p className="muted-text">Loading the signed documents…</p> : null}
      {list && list.documents.length === 0 ? (
        <p className="muted-text">
          No signed PDFs for this client yet. When a letter you sent for signature is signed, its signed PDF
          appears here by itself.
        </p>
      ) : null}
      {list && list.documents.length > 0 ? (
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Signed</th>
                <th>Signed by</th>
                <th aria-label="Download" />
              </tr>
            </thead>
            <tbody>
              {list.documents.map((document) => {
                const kind = ENGAGEMENT_KIND_LABELS[document.kind] ?? 'Engagement'
                const what = document.subject ? `${kind} letter: ${document.subject}` : `${kind} letter`
                return (
                  <tr key={document.requestId}>
                    <td>
                      <strong>{document.fileName}</strong>
                      <div className="muted-text">{what}</div>
                      {/* Signed by the client, but the letter itself is not (or no longer) "Signed":
                          it was edited after sending, is waiting to be finished by hand, or was
                          replaced or voided since. */}
                      {document.engagementStatus && document.engagementStatus !== 'signed' ? (
                        <div className="muted-text">
                          The letter is {ENGAGEMENT_STATUS_LABELS[document.engagementStatus] ?? document.engagementStatus}
                        </div>
                      ) : null}
                      {document.testMode ? <div className="muted-text">Test signing (not legally binding)</div> : null}
                    </td>
                    <td>{engagementInstantLabel(document.signedAt) || '-'}</td>
                    <td>{document.signers.join(', ') || '-'}</td>
                    <td>
                      <div className="button-row">
                        <a
                          className="ghost-action"
                          href={engagementEsignPdfUrl(document.engagementId, document.requestId)}
                          download
                          aria-label={`Download ${document.fileName}`}
                        >
                          Download PDF
                        </a>
                        <Link to={`/engagements/${document.engagementId}`} aria-label={`Open the letter: ${what}`}>
                          Open the letter
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {/* Marked signed, no PDF kept: signed by hand, or the signed PDF could not be kept. */}
      {list && list.signedWithoutPdf > 0 ? (
        <p className="muted-text">
          {list.signedWithoutPdf === 1
            ? '1 signed letter for this client has no signed PDF here (it was marked as signed by hand, or its signed PDF could not be kept).'
            : `${list.signedWithoutPdf} signed letters for this client have no signed PDF here (they were marked as signed by hand, or their signed PDF could not be kept).`}{' '}
          Find them on this client's Billing tab, under Engagements.
        </p>
      ) : null}
    </div>
  )
}
