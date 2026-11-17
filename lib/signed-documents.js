/**
 * The Signed documents list on a client's page (featreq-d4548b2c). Brittany:
 * "Documents a client has signed, such as engagement letters, are not available
 * from that client's folder ... Each client's folder should have a Documents
 * area that lists all documents that client has signed ... When a document is
 * signed, its saved PDF should automatically appear ... Only signed, saved PDFs
 * should appear here. Unsigned documents and drafts should not."
 *
 * What the app keeps a signed PDF of: a letter that went out with Send for
 * signature and was completed by the signer (one PDF per signature request,
 * `signature_documents`). So the list is read off the client's engagements and
 * their completed requests; nothing is copied or stored a second time, and the
 * PDF itself is still served by the engagement's own route.
 *
 * ONLY a request whose signed PDF is kept is listed. A completed request with
 * no PDF is not a signed document here: it can be one the signer finished whose
 * PDF could not be fetched (yet), and it can be one that was marked complete at
 * the signing service by a person, which the client never signed and which will
 * never have a PDF. A letter that IS marked signed and has no kept PDF (signed
 * by hand, or its PDF was never kept) is counted, not listed.
 *
 * A TEST-MODE signing is not binding and never marks a real client's letter
 * signed, but its PDF is kept. That PDF is listed only once the letter itself
 * is marked signed (the Test client's letter, or one the owner marked signed
 * because the signature was real); until then it is a test, not a document the
 * client signed.
 *
 * A letter with no client yet (a prospect's) is on no client's page. Signing it
 * creates the client; if the e-signature could not mark it signed (it was
 * edited after sending, say), its PDF shows here once it is marked signed by
 * hand, which is when the client exists.
 */

/**
 * @param {object} args
 * @param {object[]} args.engagements - the client's engagements (any status).
 * @param {object[]} args.kept - the store's rows for those engagements' COMPLETED
 *   requests (`listSignedDocumentsForEngagements`): `documentId` is null when
 *   no signed PDF is kept for the request.
 * @returns {{ documents: object[], signedWithoutPdf: number }}
 */
export function clientSignedDocuments({ engagements, kept } = {}) {
  const byId = new Map()
  for (const engagement of Array.isArray(engagements) ? engagements : []) {
    if (engagement && typeof engagement.id === 'string' && engagement.id) byId.set(engagement.id, engagement)
  }
  const documents = []
  for (const row of Array.isArray(kept) ? kept : []) {
    const engagement = row ? byId.get(row.engagementId) : null
    // Never a document of a letter that is not this client's, and never a
    // line with no PDF behind it.
    if (!engagement || !row.requestId || !row.documentId) continue
    // A test signing of a letter that is not marked signed is not a signed document.
    if (row.testMode === true && !engagement.signedAt) continue
    documents.push({
      requestId: String(row.requestId),
      engagementId: engagement.id,
      kind: engagement.kind ?? 'original',
      engagementStatus: engagement.status ?? null,
      subject: String(engagement.subject ?? ''),
      fileName: String(row.fileName ?? '') || 'signed-engagement-letter.pdf',
      byteSize: Number(row.byteSize) || 0,
      signedAt: row.signedAt ?? engagement.signedAt ?? null,
      // By name; by address when no name is on file (a blank name is no name).
      signers: (Array.isArray(row.signers) ? row.signers : [])
        .map((signer) => String(signer?.name ?? '').trim() || String(signer?.email ?? '').trim())
        .filter(Boolean),
      testMode: row.testMode === true,
    })
  }
  // Newest signing first; one with no date last; then a stable order.
  documents.sort(
    (a, b) =>
      String(b.signedAt ?? '').localeCompare(String(a.signedAt ?? '')) ||
      a.requestId.localeCompare(b.requestId),
  )
  const withPdf = new Set(documents.map((document) => document.engagementId))
  // Marked signed, with no signed PDF kept: signed by hand, or its PDF could
  // not be kept. There is nothing to list; the page says how many.
  let signedWithoutPdf = 0
  for (const engagement of byId.values()) {
    if (engagement.signedAt && !withPdf.has(engagement.id)) signedWithoutPdf += 1
  }
  return { documents, signedWithoutPdf }
}
