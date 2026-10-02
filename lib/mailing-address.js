/**
 * A mailing address as the lines a document prints: street, second line, then
 * "City, ST 12345" as one line (city and state joined by a comma, a single space
 * before the postal code). Blank parts are dropped and each part is trimmed, so
 * a half-filled record prints no empty lines and a client with no address prints
 * nothing at all.
 *
 * ONE copy, shared by the printed invoice sheet and the emailed invoice PDF, so
 * the document a client prints and the one attached to the email cannot disagree
 * about where they are billed.
 *
 * @param {object|null|undefined} source anything with addressLine1, addressLine2,
 *   city, state and postalCode (a client record)
 * @returns {string[]}
 */
export function mailingAddressLines(source) {
  const clean = (part) => String(part ?? '').trim()
  // The usual US form: "Austin, TX 78701" - city and state joined by a comma, the
  // postal code after a single space. Whatever is missing just drops out.
  const cityLine = [
    [source?.city, source?.state].map(clean).filter(Boolean).join(', '),
    clean(source?.postalCode),
  ]
    .filter(Boolean)
    .join(' ')
  return [source?.addressLine1, source?.addressLine2, cityLine].map(clean).filter(Boolean)
}
