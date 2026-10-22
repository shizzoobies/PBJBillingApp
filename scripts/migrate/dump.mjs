// Dump the source (Railway) database to a custom-format archive.
//
//   $env:SOURCE_DATABASE_URL = '<url of the tunnel or database>'
//   node scripts/migrate/dump.mjs [--out <dir>] [--source-url-env NAME]
//
// Runs:  pg_dump -Fc --no-owner --no-privileges --no-comments -f <file>
// with the connection in libpq environment variables (the URL is not in argv,
// is never printed). Writes <out>/backups/railway-<YYYYMMDD-HHMMSS>.dump
// (UTC). The default <out> is outside git; a directory inside this repo is
// refused, and so is a cloud-synced one (OneDrive, Dropbox, Google Drive, iCloud:
// the dump is a full copy of production data). pg_dump writes to <name>.partial;
// the file only gets its real name after pg_dump exited 0 AND pg_restore --list
// read it back, so a half-written file can never be mistaken for a dump.

import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import {
  DEFAULT_DUMP_DIR,
  REPO_ROOT,
  isCloudSyncedPath,
  formatBytes,
  isMain,
  lastLines,
  parseArgs,
  pgBinary,
  readUrl,
  redact,
  runTool,
  toolEnv,
  utcStamp,
} from './lib.mjs'

export function dumpArgs(file) {
  return ['-Fc', '--no-owner', '--no-privileges', '--no-comments', '-f', file]
}

function insideRepo(dir, repoRoot) {
  const relative = path.relative(repoRoot, dir)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || console.log
  const spawn = deps.spawn || nodeSpawn
  const now = deps.now || (() => new Date())
  const platform = deps.platform || process.platform
  const repoRoot = deps.repoRoot || REPO_ROOT
  const statFile = deps.stat || stat
  const makeDir = deps.mkdir || mkdir
  const removeFile = deps.rm || rm
  const renameFile = deps.rename || rename

  let parsed
  let source
  try {
    parsed = parseArgs(argv, { options: ['out', 'source-url-env'] })
    source = readUrl(env, parsed.options['source-url-env'], 'SOURCE_DATABASE_URL')
  } catch (error) {
    log(`dump: ${error.message}`)
    return 2
  }

  const outDir = path.resolve(parsed.options.out || DEFAULT_DUMP_DIR)
  if (insideRepo(outDir, repoRoot)) {
    log(`dump: refusing to write a database dump inside the git repository (${outDir}). Use --out with a folder outside it.`)
    return 2
  }

  if (isCloudSyncedPath(outDir)) {
    log(`dump: refusing ${outDir}: it looks like a cloud-synced folder, and the dump is a full copy of production data. Use a local, unsynced folder.`)
    return 2
  }

  const backupsDir = path.join(outDir, 'backups')
  const finalFile = path.join(backupsDir, `railway-${utcStamp(now())}.dump`)
  const file = `${finalFile}.partial`
  await makeDir(backupsDir, { recursive: true })

  let childEnv
  try {
    childEnv = toolEnv(env, source.url)
  } catch (error) {
    log(`dump: ${error.message}`)
    return 2
  }

  const pgDump = pgBinary('pg_dump', env, platform)
  log(`dump: reading ${source.varName}; writing ${finalFile} (via ${path.basename(file)})`)
  const started = Date.now()
  let result
  try {
    result = await runTool(spawn, pgDump, dumpArgs(file), childEnv)
  } catch (error) {
    log(`dump: could not start ${pgDump}: ${redact(error.message, [source.url])}. Set PG_BIN to the PostgreSQL 18 bin folder.`)
    return 1
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  log(`dump: pg_dump exit code ${result.code} after ${seconds}s`)

  if (result.code !== 0) {
    for (const line of lastLines(redact(result.stderr, [source.url]), 20)) log(`  ${line}`)
    await removeFile(file, { force: true })
    log('dump: FAILED (the partial file was removed)')
    return 1
  }

  const { size } = await statFile(file)
  log(`dump: ${formatBytes(size)} (${size} bytes)`)
  if (size < 1024) {
    log('dump: FAILED - the archive is implausibly small')
    await removeFile(file, { force: true })
    return 1
  }

  // Prove the archive is readable. --list reads only the table of contents.
  let listing
  try {
    listing = await runTool(spawn, pgBinary('pg_restore', env, platform), ['--list', file], toolEnv(env))
  } catch (error) {
    log(`dump: could not start pg_restore --list: ${error.message}`)
    await removeFile(file, { force: true })
    return 1
  }
  if (listing.code !== 0) {
    for (const line of lastLines(redact(listing.stderr, [source.url]), 20)) log(`  ${line}`)
    log(`dump: FAILED - pg_restore --list exit code ${listing.code}`)
    await removeFile(file, { force: true })
    return 1
  }
  const entries = listing.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith(';')).length
  log(`dump: archive readable, ${entries} table-of-contents entries`)
  await renameFile(file, finalFile)
  log(`dump: OK ${finalFile}`)
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`dump: ${error.message}`)
      process.exit(1)
    },
  )
}
