/**
 * The shape of an email address typed on a client or a contact. lib/recipient-addresses.js
 * pulls one clean address out of whatever is stored when a letter or an invoice is sent and
 * drops the rest; this is the earlier warning, so an odd value is seen when it is typed
 * rather than as a skipped client at send time. It judges the SHAPE only (never whether the
 * mailbox exists), and is a hint in the forms - the server never refuses a save over it.
 */

// Letters and digits in any script, so an internationalized domain (bücher.example, 例え.jp) or its
// punycode form (xn--...) passes: this is a hint about the shape, never a reason to refuse a real address.
const PLAIN_ADDRESS =
  /^[^\s@<>,;()"]+@(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)$/iu

/** null when `value` is empty or one plain `local@domain.tld` address (trimmed); otherwise a short reason. */
export function emailShapeProblem(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  if (PLAIN_ADDRESS.test(text)) return null
  const addressy = text.split(/[\s,;]+/).filter((part) => part.includes('@'))
  if (addressy.length > 1) return 'Enter one email address'
  if (/<[^<>]*>/.test(text)) return 'Enter just the address, no name'
  return 'That does not look like an email address'
}
