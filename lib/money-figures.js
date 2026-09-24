/**
 * The money-figure regex, shared between the server's letter-figure guard
 * (lib/assistant.js, `validateProposalLetter` / the send route's stale-letter
 * check) and the client's "this letter is stale" warning
 * (src/lib/proposals.ts) — ONE pattern, in ONE file both sides import, so the
 * two can never quietly disagree about what counts as a dollar figure (final
 * fix wave, Important 1).
 */

// A number: "1,234.56", "1234", or a bare ".50" (review I2).
const MONEY_NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2}`
// A real figure boundary: not immediately followed by another digit, or by a
// comma that itself is immediately followed by a digit — so "$1,8000" is not
// misread as "$1,800" with a stray trailing digit, while an ordinary
// sentence comma after a figure ("$1,147.13, so...") still reads fine
// (fix batch 2, L-a).
const MONEY_BOUNDARY = String.raw`(?!,?\d)`
// Every shape a dollar figure has shown up in a drafted letter: "$1,234.56",
// "$ 1,234.56" (any run of spaces), "US$1,234.56", "USD 1,234.56",
// "USD1,234.56" (no space), "1,234.56 USD", "1,234.56 dollars", and
// "1 dollar" (singular) (review I2; fix batch 2, L-a).
const MONEY_PATTERN = new RegExp(
  String.raw`(?:US)?\$\s*(${MONEY_NUMBER})${MONEY_BOUNDARY}` +
    String.raw`|\bUSD\s*(${MONEY_NUMBER})${MONEY_BOUNDARY}` +
    String.raw`|(${MONEY_NUMBER})${MONEY_BOUNDARY}\s*\bUSD\b` +
    String.raw`|(${MONEY_NUMBER})${MONEY_BOUNDARY}\s*\bdollars?\b`,
  'gi',
)

/** Every dollar figure in a piece of prose, in any of its written forms, as whole cents. */
export function dollarFiguresInCents(text) {
  const out = []
  for (const match of String(text ?? '').matchAll(MONEY_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (!raw) continue
    const [wholePart, centsPart] = raw.split('.')
    const whole = wholePart ? Number(wholePart.replace(/,/g, '')) : 0
    const cents = centsPart ? Number(centsPart.padEnd(2, '0')) : 0
    out.push(whole * 100 + cents)
  }
  return out
}
