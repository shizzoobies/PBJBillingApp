/**
 * JSON with object keys in sorted order, recursively, so two values that hold
 * the same data serialize identically whatever order their keys were written in.
 *
 * WHY: Postgres `jsonb` does not keep key order (it stores shorter keys first),
 * so an object built in memory and the same object read back from a `jsonb`
 * column stringify differently with plain `JSON.stringify`. Any "did this
 * change?" check that compares an in-memory copy with a re-read row must use
 * this instead, or identical values compare unequal (2026-11-01: every Send of
 * an invoice with an attached advance answered "This invoice changed while it
 * was being sent"). The JSON file backend keeps key order, so tests on it never
 * see the difference.
 *
 * Arrays keep their order (order is data). `undefined` object members are
 * dropped and `undefined` array items become `null`, exactly as JSON.stringify
 * does. No cycle handling: these are plain JSON values.
 */
export function stableStringify(value) {
  return JSON.stringify(canonical(value))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)))
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return canonical(value.toJSON())
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined && typeof value[key] !== 'function') out[key] = canonical(value[key])
    }
    return out
  }
  return value
}
