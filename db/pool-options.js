// How the app's Postgres pool decides about TLS. Kept in its own tiny module
// (re-exported from db/store.js) so the migration scripts in scripts/migrate/
// build their connections exactly the way the app does without importing the
// 34,000-line store.
//
// The rule, in one place:
//   * `sslmode=require | verify-ca | verify-full` in the URL, or the same
//     value in PGSSLMODE (the URL wins, as in libpq), turns TLS ON and always
//     VERIFIES the server certificate against Node's bundled CAs. Neon (and any
//     other host with a public CA) works as-is. `require` is treated as
//     `verify-full` here: libpq's `require` means "encrypt but do not check who
//     answered", and the app never runs without the check.
//   * `sslmode=disable | allow | prefer` -> no TLS (node-pg cannot fall back
//     from TLS to plain, so `prefer` is plain).
//   * No sslmode anywhere -> options untouched, which is Railway's internal
//     non-TLS URL exactly as before.
//   * `no-verify` (and anything unrecognized) throws: there is no switch in
//     this app that turns certificate checking off.
//   * `sslrootcert=system` (a libpq spelling for "use the operating system's
//     CAs", which is what the backup workflow's URL carries) is dropped: Node's
//     bundled CAs already are the system-style roots, and pg-connection-string
//     would otherwise try to read a file literally named "system".
//
// The `sslmode` query parameter is stripped from the connection string we hand
// to node-pg and the verification is spelled out in the `ssl` option instead.
// (pg-connection-string 2.14 already maps a bare `require` to a verified
// connection, but only with a deprecation warning, and a parsed URL overrides
// the `ssl` option passed beside it - so we make the decision here, once,
// explicitly, rather than depend on that library behavior.)

const VERIFIED_MODES = new Set(['require', 'verify-ca', 'verify-full'])
const PLAIN_MODES = new Set(['disable', 'allow', 'prefer'])

const SSLMODE_PARAM = /([?&])sslmode=([^&#]*)&?/i
const SYSTEM_ROOT_PARAM = /([?&])sslrootcert=system&?/i

function tidy(url) {
  return url.replace(/[?&]$/, '')
}

export function poolOptions(databaseUrl, env = process.env) {
  let connectionString = String(databaseUrl)
  let mode = ''

  const found = SSLMODE_PARAM.exec(connectionString)
  if (found) {
    mode = decodeURIComponent(found[2])
    connectionString = tidy(connectionString.replace(SSLMODE_PARAM, '$1'))
  }
  if (SYSTEM_ROOT_PARAM.test(connectionString)) {
    connectionString = tidy(connectionString.replace(SYSTEM_ROOT_PARAM, '$1'))
  }
  if (!mode) mode = String(env.PGSSLMODE || '')
  mode = mode.trim().toLowerCase()

  if (!mode) return { connectionString }
  if (VERIFIED_MODES.has(mode)) return { connectionString, ssl: { rejectUnauthorized: true } }
  if (PLAIN_MODES.has(mode)) return { connectionString, ssl: false }
  throw new Error(
    `Unsupported sslmode "${mode}": use require, verify-ca or verify-full (certificate checking cannot be turned off), or disable.`,
  )
}
