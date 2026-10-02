import { mailingAddressLines } from './mailing-address.js'

/**
 * The firm's identity block under its name: address and contact, one line
 * each, blanks dropped. ONE copy, shared by the invoice PDF's letterhead, the
 * invoice email's footer, the proposal PDF and the proposal letter prompt — so
 * two documents about the same firm can never disagree about how to reach it.
 *
 * No tagline — she struck it off the letterhead on the marked-up sample
 * (featreq-97ae3214, §1d). `firmSettings.tagline` is still stored and still
 * shown in Settings; it just does not belong on a document a client files.
 *
 * @param {object|null|undefined} firmSettings
 * @returns {string[]}
 */
export function firmDetailLines(firmSettings) {
  return [
    // Street, second line, "City, ST 12345" — the same rule the client's
    // address uses, so both blocks of one document are written alike.
    ...mailingAddressLines(firmSettings),
    firmSettings?.phone,
    firmSettings?.email,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
}
