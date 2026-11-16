#!/usr/bin/env node
// Cloudflare's image registry: prove the images we keep are whole, and delete the tags of a
// repository that is no longer used.
//
// Run it from a GitHub Actions step (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the
// environment): the laptop's Cloudflare login is refused by the registry. Used on 2026-11-16
// to delete the images of the old container and of the staging copy.
//
//   node scripts/cf/registry-images.mjs list
//   node scripts/cf/registry-images.mjs verify <repository> [--expect-tail <end of a digest>]
//   node scripts/cf/registry-images.mjs delete-all <repository> [--dry]
//
// verify downloads every tag's manifest and every layer of the repository and checks each
// one against its sha256, so it fails if a deletion elsewhere took something a kept image
// needs. --expect-tail also requires one tag's digest to end with the given text: pass the
// live image's tail from GET /internal/rollout to prove the repository is the live one.
//
// delete-all removes every tag of ONE repository through `wrangler containers images
// delete`. It refuses the repository production runs on, whatever it is told. Nothing here
// prints the registry password or an address that holds the account id.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** The repository production's instances are started from (wrangler.jsonc: AppHost, image "app"). */
export const LIVE_REPOSITORY = 'pbjbillingapp-apphost-app'
const REGISTRY = 'registry.cloudflare.com'
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const short = (digest) => String(digest).slice(-12)

/** Run wrangler and return what it printed. A failure never carries what it printed. */
function wrangler(args) {
  try {
    return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    throw new Error('wrangler ' + args.slice(0, 3).join(' ') + ' failed (exit ' + (error?.status ?? '?') + ')')
  }
}

/** [{ name, tags }] for every repository that has a tag, from `wrangler containers images list --json`. */
export function parseRepositories(out) {
  const start = out.indexOf('[')
  if (start < 0) throw new Error('the image list was not JSON')
  const list = JSON.parse(out.slice(start))
  if (!Array.isArray(list)) throw new Error('the image list was not a list')
  return list.map((entry) => ({ name: String(entry.name), tags: (entry.tags ?? []).map(String) }))
}

const listRepositories = () => parseRepositories(wrangler(['containers', 'images', 'list', '--json']))

/**
 * A reader for one repository. `base` is the repository's address and `headers` carry the
 * login; both stay inside this process. Every answer is checked against its sha256.
 */
export function registryReader({ base, headers, fetch: get = fetch }) {
  return {
    /** A manifest by tag or digest: { digest, body }, the digest computed from the bytes. */
    async manifest(reference) {
      const response = await get(base + '/manifests/' + reference, { headers: { ...headers, Accept: MANIFEST_TYPES }, signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error('manifest ' + short(reference) + ' answered ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      const digest = sha256(bytes)
      const said = response.headers.get('docker-content-digest')
      if (said && said !== digest) throw new Error('manifest ' + short(reference) + ' does not match the digest the registry gave')
      if (reference.startsWith('sha256:') && reference !== digest) throw new Error('manifest ' + short(reference) + ' has other content')
      return { digest, body: JSON.parse(bytes.toString('utf8')) }
    },
    /** Download one blob and check its sha256 and size. Returns the bytes counted. */
    async blob(digest, size) {
      // no-cache: the answer must come from the registry's store, not from a copy kept on the way.
      const response = await get(base + '/blobs/' + digest, { headers: { ...headers, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15 * 60_000) })
      if (!response.ok) throw new Error('blob ' + short(digest) + ' answered ' + response.status)
      const hash = createHash('sha256')
      let bytes = 0
      for await (const chunk of response.body) {
        hash.update(chunk)
        bytes += chunk.length
      }
      if ('sha256:' + hash.digest('hex') !== digest) throw new Error('blob ' + short(digest) + ' has other content')
      if (Number.isFinite(size) && size !== bytes) throw new Error('blob ' + short(digest) + ' is ' + bytes + ' bytes, the manifest says ' + size)
      return bytes
    },
  }
}

/**
 * Download and check every tag: its manifest (walking an index down to its image manifests),
 * its config and every layer. Throws at the first thing that is missing or different, and,
 * when `expectTail` is given, if no tag's digest ends with it.
 */
export async function verifyTags({ repository, tags, registry, expectTail = null, log = console.log }) {
  if (!tags.length) throw new Error(repository + ' has no tags')
  const checked = new Map() // blob digest -> bytes, so a layer several tags share is downloaded once
  let matched = false

  const walk = async (reference) => {
    const { digest, body } = await registry.manifest(reference)
    const blobs = []
    if (Array.isArray(body.manifests)) {
      if (!body.manifests.length) throw new Error('manifest ' + short(reference) + ' lists no images')
      for (const child of body.manifests) blobs.push(...(await walk(child.digest)).blobs)
    } else {
      if (!body.config?.digest || !Array.isArray(body.layers) || !body.layers.length) throw new Error('manifest ' + short(reference) + ' has no config or no layers')
      for (const part of [body.config, ...body.layers]) blobs.push({ digest: part.digest, size: part.size })
    }
    return { digest, blobs }
  }

  for (const tag of tags) {
    let fresh = 0
    let found
    try {
      found = await walk(tag)
      for (const blob of found.blobs) {
        if (checked.has(blob.digest)) continue
        checked.set(blob.digest, await registry.blob(blob.digest, blob.size))
        fresh += 1
      }
    } catch (error) {
      throw new Error(repository + ':' + tag + ': ' + String(error?.message ?? error))
    }
    const megabytes = Math.round(found.blobs.reduce((sum, blob) => sum + checked.get(blob.digest), 0) / 1e6)
    const live = Boolean(expectTail) && found.digest.endsWith(expectTail)
    matched ||= live
    log('OK ' + repository + ':' + tag + ' ...' + short(found.digest) + ' ' + found.blobs.length + ' parts, ' + megabytes + ' MB (' + fresh + ' downloaded now)' + (live ? '  <- the live image' : ''))
  }
  if (expectTail && !matched) throw new Error('no tag of ' + repository + ' has a digest ending ' + expectTail + ': this is not the repository the live instance runs on')
  log('WHOLE: ' + tags.length + ' tags of ' + repository + ', ' + checked.size + ' parts downloaded and checked.')
  return { tags: tags.length, parts: checked.size }
}

/**
 * Delete every tag of one repository. `list()` gives [{ name, tags }], `remove(image)`
 * deletes one "repository:tag". Refuses the live repository, whatever it is told.
 */
export function deleteAllTags({ repository, dry = false, list, remove, log = console.log }) {
  if (repository === LIVE_REPOSITORY) throw new Error('REFUSED: ' + repository + ' is the repository production runs on.')
  if (typeof repository !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(repository)) throw new Error('REFUSED: not a repository name.')
  const tagsOf = () => list().find((entry) => entry.name === repository)?.tags ?? []
  const tags = tagsOf()
  if (!tags.length) {
    log('Nothing to delete: ' + repository + ' has no tags.')
    return 0
  }
  for (const tag of tags) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(tag)) throw new Error('REFUSED: ' + repository + ' has a tag that is not a plain tag.')
  }
  log((dry ? 'DRY RUN: would delete ' : 'Deleting ') + tags.length + ' tags of ' + repository + '.')
  if (dry) return 0
  for (const tag of tags) remove(repository + ':' + tag)
  const left = tagsOf()
  if (left.length) throw new Error(left.length + ' tags of ' + repository + ' are still listed.')
  log('Deleted every tag of ' + repository + '.')
  return tags.length
}

/** The real registry, logged in with a short-lived pull password from wrangler. */
function liveReader(repository) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')
  const password = wrangler(['containers', 'registries', 'credentials', REGISTRY, '--pull', '--expiration-minutes', '60']).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (!password) throw new Error('no registry password came back')
  return registryReader({
    base: 'https://' + REGISTRY + '/v2/' + account + '/' + repository,
    headers: { Authorization: 'Basic ' + Buffer.from('v1:' + password).toString('base64') },
  })
}

const USAGE = 'usage: registry-images.mjs list | verify <repository> [--expect-tail <hex>] | delete-all <repository> [--dry]'

/**
 * Read the command line strictly: anything not understood is an error, so a misspelled
 * --dry can never turn a dry run into a real deletion.
 */
export function parseCommand([command, repository, ...rest]) {
  if (command === 'list' && repository === undefined) return { command }
  if (command === 'verify' && repository && !repository.startsWith('-')) {
    if (!rest.length) return { command, repository, expectTail: null }
    if (rest.length === 2 && rest[0] === '--expect-tail' && /^[0-9a-f]{8,64}$/.test(rest[1])) return { command, repository, expectTail: rest[1] }
    throw new Error('verify takes only --expect-tail <the end of a digest>')
  }
  if (command === 'delete-all' && repository && !repository.startsWith('-')) {
    if (!rest.length) return { command, repository, dry: false }
    if (rest.length === 1 && rest[0] === '--dry') return { command, repository, dry: true }
    throw new Error('delete-all takes only --dry')
  }
  throw new Error(USAGE)
}

async function main(argv) {
  const { command, repository, expectTail, dry } = parseCommand(argv)
  if (command === 'list') {
    for (const entry of listRepositories()) console.log(entry.name + ': ' + entry.tags.length + ' tags')
    return
  }
  if (command === 'verify') {
    const tags = listRepositories().find((entry) => entry.name === repository)?.tags ?? []
    await verifyTags({ repository, tags, registry: liveReader(repository), expectTail })
    return
  }
  if (command === 'delete-all') {
    deleteAllTags({
      repository,
      dry,
      list: listRepositories,
      remove: (image) => execFileSync('npx', ['wrangler', 'containers', 'images', 'delete', image, '--skip-confirmation'], { stdio: ['ignore', 'inherit', 'inherit'] }),
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    // The message only: an error from a child process can carry what the child printed.
    console.log('FAILED: ' + String(error?.message ?? error))
    process.exit(1)
  }
}
