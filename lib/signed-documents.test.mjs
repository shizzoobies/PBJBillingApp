import { describe, expect, it } from 'vitest'
import { clientSignedDocuments } from './signed-documents.js'

/**
 * featreq-d4548b2c: "Each client's folder should have a Documents area that
 * lists all documents that client has signed ... Only signed, saved PDFs should
 * appear here. Unsigned documents and drafts should not."
 */

const engagement = (over = {}) => ({
  id: 'eng-1',
  kind: 'original',
  status: 'signed',
  subject: 'Engagement letter',
  signedAt: '2026-10-22T15:00:00.000Z',
  ...over,
})
const kept = (over = {}) => ({
  requestId: 'sigreq-1',
  engagementId: 'eng-1',
  documentId: 'sigdoc-1',
  fileName: 'Signed letter.pdf',
  byteSize: 20480,
  signedAt: '2026-10-22T14:59:00.000Z',
  testMode: false,
  signers: [{ name: 'Pat Example', email: 'pat@example.invalid' }],
  ...over,
})

describe('clientSignedDocuments', () => {
  it('lists a signed, kept PDF with what it is and who signed', () => {
    expect(clientSignedDocuments({ engagements: [engagement()], kept: [kept()] })).toEqual({
      documents: [
        {
          requestId: 'sigreq-1',
          engagementId: 'eng-1',
          kind: 'original',
          engagementStatus: 'signed',
          subject: 'Engagement letter',
          fileName: 'Signed letter.pdf',
          byteSize: 20480,
          signedAt: '2026-10-22T14:59:00.000Z',
          signers: ['Pat Example'],
          testMode: false,
        },
      ],
      signedWithoutPdf: 0,
    })
  })

  it('newest signing first, amendments and the original together', () => {
    const result = clientSignedDocuments({
      engagements: [
        engagement(),
        engagement({ id: 'eng-2', kind: 'amendment', subject: 'Payroll added' }),
        engagement({ id: 'eng-3', kind: 'superseding', subject: 'New letter' }),
      ],
      kept: [
        kept(),
        kept({ requestId: 'sigreq-3', engagementId: 'eng-3', documentId: 'sigdoc-3', signedAt: '2026-11-10T10:00:00.000Z' }),
        kept({ requestId: 'sigreq-2', engagementId: 'eng-2', documentId: 'sigdoc-2', signedAt: '2026-11-01T10:00:00.000Z' }),
      ],
    })
    expect(result.documents.map((document) => [document.requestId, document.kind])).toEqual([
      ['sigreq-3', 'superseding'],
      ['sigreq-2', 'amendment'],
      ['sigreq-1', 'original'],
    ])
  })

  it('nothing for a draft or a letter that is out and not signed: there is no completed request', () => {
    expect(
      clientSignedDocuments({
        engagements: [engagement({ status: 'draft', signedAt: null }), engagement({ id: 'eng-2', status: 'sent', signedAt: null })],
        kept: [],
      }),
    ).toEqual({ documents: [], signedWithoutPdf: 0 })
  })

  it('a letter marked as signed by hand has no PDF: counted, not listed', () => {
    const result = clientSignedDocuments({
      engagements: [engagement(), engagement({ id: 'eng-2', kind: 'amendment' }), engagement({ id: 'eng-3', status: 'superseded' })],
      kept: [kept()],
    })
    expect(result.documents).toHaveLength(1)
    expect(result.signedWithoutPdf).toBe(2)
  })

  // "Only signed, saved PDFs should appear here."
  it('a completed request with no PDF kept is not listed; its letter, once marked signed, is counted', () => {
    const noPdf = kept({ documentId: null, fileName: null, byteSize: 0 })
    // The signer finished and the letter is signed, but the PDF could not be kept.
    expect(clientSignedDocuments({ engagements: [engagement()], kept: [noPdf] })).toEqual({
      documents: [],
      signedWithoutPdf: 1,
    })
    // Marked complete at the signing service by a person: the client never
    // signed, the letter is not signed, and no PDF will ever come.
    expect(
      clientSignedDocuments({ engagements: [engagement({ status: 'sent', signedAt: null })], kept: [noPdf] }),
    ).toEqual({ documents: [], signedWithoutPdf: 0 })
  })

  it('a letter with one request that kept its PDF and one that did not is listed once and not counted', () => {
    const result = clientSignedDocuments({
      engagements: [engagement()],
      kept: [kept(), kept({ requestId: 'sigreq-0', documentId: null })],
    })
    expect(result.documents.map((document) => document.requestId)).toEqual(['sigreq-1'])
    expect(result.signedWithoutPdf).toBe(0)
  })

  // A test-mode signing is not binding and never marks a real client's letter
  // signed, though its PDF is kept ("Unsigned documents ... should not").
  it('a test signing is not a signed document until its letter is marked signed', () => {
    expect(
      clientSignedDocuments({
        engagements: [engagement({ status: 'sent', signedAt: null })],
        kept: [kept({ testMode: true })],
      }),
    ).toEqual({ documents: [], signedWithoutPdf: 0 })
    // The Test client's letter, or one the owner marked signed because it was real.
    const marked = clientSignedDocuments({ engagements: [engagement()], kept: [kept({ testMode: true })] })
    expect(marked.documents).toHaveLength(1)
    expect(marked.documents[0]).toMatchObject({ testMode: true, engagementStatus: 'signed' })
    expect(marked.signedWithoutPdf).toBe(0)
  })

  // The client signed, but the app did not mark the letter signed (it was
  // edited after sending, or amendments are open): the PDF is a signed one.
  it('a real signing whose letter is not marked signed yet is listed, with the letter’s status', () => {
    const result = clientSignedDocuments({
      engagements: [engagement({ status: 'sent', signedAt: null }), engagement({ id: 'eng-2', status: 'void', signedAt: null })],
      kept: [kept(), kept({ requestId: 'sigreq-2', engagementId: 'eng-2', documentId: 'sigdoc-2' })],
    })
    expect(result.documents.map((document) => [document.requestId, document.engagementStatus])).toEqual([
      ['sigreq-1', 'sent'],
      ['sigreq-2', 'void'],
    ])
    expect(result.signedWithoutPdf).toBe(0)
  })

  it('never a document of a letter that is not among this client’s', () => {
    const result = clientSignedDocuments({
      engagements: [engagement()],
      kept: [kept(), kept({ requestId: 'sigreq-x', engagementId: 'eng-other' }), null, { engagementId: 'eng-1' }],
    })
    expect(result.documents.map((document) => document.requestId)).toEqual(['sigreq-1'])
  })

  it('names a signer by email when there is no name, marks a test signing, and falls back on the letter’s own date and a file name', () => {
    const result = clientSignedDocuments({
      engagements: [engagement()],
      kept: [
        kept({
          signedAt: null,
          fileName: '',
          testMode: true,
          signers: [{ name: '', email: 'pat@example.invalid' }, { name: ' ' }, { name: '  ', email: ' sam@example.invalid ' }],
        }),
      ],
    })
    expect(result.documents[0]).toMatchObject({
      // A blank name is no name: the address is used.
      signers: ['pat@example.invalid', 'sam@example.invalid'],
      testMode: true,
      signedAt: '2026-10-22T15:00:00.000Z',
      fileName: 'signed-engagement-letter.pdf',
    })
  })

  it('reads nothing as nothing', () => {
    expect(clientSignedDocuments()).toEqual({ documents: [], signedWithoutPdf: 0 })
    expect(clientSignedDocuments({ engagements: null, kept: 'x' })).toEqual({ documents: [], signedWithoutPdf: 0 })
  })
})
