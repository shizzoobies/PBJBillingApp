import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_PROD_ENV_FILE = 'D:\\PBJ Accounting Work\\secrets\\prod.env'

// Resolve symlinks before checking ancestors, including worktree .git files.
export function externalEnvPath(file) {
  let resolved
  try { resolved = realpathSync(file) } catch { throw new Error('Cannot read env file: ' + file) }
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) throw new Error('Env file must be outside a git repository: ' + file)
    if (dir === path.dirname(dir)) break
  }
  return resolved
}

// No shell expansion, interpolation, or multiline values.
export function parseEnvText(text, file = 'env file') {
  const values = Object.create(null)
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error('Invalid env entry at line ' + (index + 1) + ' in ' + file)
    let value = match[2].trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      const end = value.indexOf(quote, 1)
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
        throw new Error('Invalid env entry at line ' + (index + 1) + ' in ' + file)
      }
      value = value.slice(1, end)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    values[match[1]] = value
  }
  return values
}

export function readEnvFile(file) {
  const resolved = externalEnvPath(file)
  let text
  try { text = readFileSync(resolved, 'utf8') } catch { throw new Error('Cannot read env file: ' + file) }
  return { file: resolved, text, values: parseEnvText(text, file) }
}

export function prodEnv(names, { env = process.env, readFile = readEnvFile } = {}) {
  const file = env.PBJ_PROD_ENV_FILE || DEFAULT_PROD_ENV_FILE
  const missing = names.filter((name) => !String(env[name] ?? '').trim())
  let values = {}
  if (missing.length) {
    try { values = readFile(file).values } catch {
      throw new Error('missing ' + missing.join(', ') + '; cannot load env file: ' + file)
    }
  }
  const result = {}
  for (const name of names) {
    const value = String(env[name] ?? '').trim() ? env[name] : values[name]
    if (!String(value ?? '').trim()) throw new Error('missing ' + name + ' in environment or env file: ' + file)
    result[name] = value
  }
  return result
}

// pg URL options override the ssl object. Reject downgrades and require verify-full.
export function prodDatabaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid PROD_DATABASE_URL') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Invalid PROD_DATABASE_URL')
  }
  if (url.searchParams.getAll('sslmode').some((mode) => mode !== 'verify-full') ||
      url.searchParams.has('ssl') || url.searchParams.has('uselibpqcompat')) {
    throw new Error('PROD_DATABASE_URL must use sslmode=verify-full without TLS overrides')
  }
  url.searchParams.set('sslmode', 'verify-full')
  return url.toString()
}
