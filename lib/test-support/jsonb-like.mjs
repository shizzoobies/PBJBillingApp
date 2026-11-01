/**
 * TEST SUPPORT: a value as Postgres hands it back from a `jsonb` column.
 *
 * jsonb does not keep object key order: it stores keys shorter-first, and keys
 * of equal length in byte order. Arrays keep their order. Applying this to the
 * stored copy in a file-backend test reproduces what production reads back, so
 * a "did it change?" check that is sensitive to key order fails here too.
 */
export function jsonbLike(value) {
  if (Array.isArray(value)) return value.map((item) => jsonbLike(item))
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      const left = Buffer.from(a), right = Buffer.from(b)
      return left.length - right.length || Buffer.compare(left, right)
    })
    const out = {}
    for (const key of keys) if (value[key] !== undefined) out[key] = jsonbLike(value[key])
    return out
  }
  return value
}
