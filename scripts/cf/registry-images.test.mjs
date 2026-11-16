import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LIVE_REPOSITORY, deleteAllTags, parseCommand, parseRepositories, registryReader, verifyTags } from './registry-images.mjs'

const digestOf = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** A registry held in memory, served through a stand-in for fetch. */
function fakeRegistry() {
  const manifests = new Map() // tag or digest -> bytes
  const blobs = new Map() // digest -> bytes
  const asked = []
  const addBlob = (text) => {
    const bytes = Buffer.from(text)
    blobs.set(digestOf(bytes), bytes)
    return { digest: digestOf(bytes), size: bytes.length }
  }
  const addManifest = (body, tag) => {
    const bytes = Buffer.from(JSON.stringify(body))
    manifests.set(digestOf(bytes), bytes)
    if (tag) manifests.set(tag, bytes)
    return digestOf(bytes)
  }
  const addImage = (tag, layers) => addManifest({ config: addBlob('config of ' + (tag ?? layers.join())), layers: layers.map(addBlob) }, tag)
  const saidDigest = new Map() // reference -> the digest header to send instead of the true one (null: none)
  const answer = (bytes, reference) => ({
    ok: Boolean(bytes),
    status: bytes ? 200 : 404,
    headers: { get: (name) => (name === 'docker-content-digest' && bytes ? (saidDigest.has(reference) ? saidDigest.get(reference) : digestOf(bytes)) : null) },
    arrayBuffer: async () => bytes,
    body: (async function* () { if (bytes) yield bytes })(),
  })
  const fetch = async (url, options) => {
    asked.push({ url, authorization: options.headers.Authorization, cache: options.headers['Cache-Control'] })
    const [, kind, reference] = url.match(/\/(manifests|blobs)\/(.+)$/)
    return answer((kind === 'manifests' ? manifests : blobs).get(reference), reference)
  }
  const registry = registryReader({ base: 'https://registry.test/v2/acct/repo', headers: { Authorization: 'Basic x' }, fetch })
  return { manifests, blobs, asked, saidDigest, addBlob, addManifest, addImage, registry }
}

const quiet = () => {}

test('a whole repository passes, and a layer two tags share is downloaded once', async () => {
  const fake = fakeRegistry()
  fake.addImage('one', ['base', 'app 1'])
  fake.addImage('two', ['base', 'app 2'])
  const lines = []
  const result = await verifyTags({ repository: 'repo', tags: ['one', 'two'], registry: fake.registry, log: (line) => lines.push(line) })
  assert.deepEqual(result, { tags: 2, parts: 5 })
  assert.equal(fake.asked.filter((ask) => ask.url.includes('/blobs/')).length, 5)
  assert.match(lines.at(-1), /^WHOLE: 2 tags of repo, 5 parts/)
  assert.ok(fake.asked.every((ask) => ask.authorization === 'Basic x'))
  assert.ok(fake.asked.filter((ask) => ask.url.includes('/blobs/')).every((ask) => ask.cache === 'no-cache'))
})

test('a manifest whose bytes do not match the digest the registry states fails; no stated digest is fine', async () => {
  const fake = fakeRegistry()
  fake.addImage('one', ['base'])
  fake.saidDigest.set('one', 'sha256:' + '0'.repeat(64))
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet }), /repo:one: manifest one does not match the digest the registry gave/)
  fake.saidDigest.set('one', null)
  assert.deepEqual(await verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet }), { tags: 1, parts: 2 })
})

test('a layer with no size in the manifest is still checked by its sha256', async () => {
  const fake = fakeRegistry()
  const layer = fake.addBlob('base')
  fake.addManifest({ config: fake.addBlob('config'), layers: [{ digest: layer.digest }] }, 'one')
  assert.equal((await verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet })).parts, 2)
  fake.blobs.set(layer.digest, Buffer.from('?'))
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet }), /has other content/)
})

test('the command line is read strictly: a misspelled --dry is an error, never a real deletion', () => {
  assert.deepEqual(parseCommand(['list']), { command: 'list' })
  assert.deepEqual(parseCommand(['verify', 'repo']), { command: 'verify', repository: 'repo', expectTail: null })
  assert.deepEqual(parseCommand(['verify', 'repo', '--expect-tail', '00fc05b6aa12']), { command: 'verify', repository: 'repo', expectTail: '00fc05b6aa12' })
  assert.deepEqual(parseCommand(['delete-all', 'repo']), { command: 'delete-all', repository: 'repo', dry: false })
  assert.deepEqual(parseCommand(['delete-all', 'repo', '--dry']), { command: 'delete-all', repository: 'repo', dry: true })
  for (const extra of [['--dry-run'], ['-dry'], ['--DRY'], ['--dry=1'], ['--dry', '--dry'], ['--dry', 'x'], ['']]) {
    assert.throws(() => parseCommand(['delete-all', 'repo', ...extra]), /delete-all takes only --dry/)
  }
  for (const extra of [['--expect-tail'], ['--expect-tail', 'XYZ'], ['--expect-tail', '00fc05b6aa12', 'more'], ['--dry']]) {
    assert.throws(() => parseCommand(['verify', 'repo', ...extra]), /verify takes only --expect-tail/)
  }
  for (const argv of [[], ['list', 'x'], ['verify'], ['delete-all'], ['delete-all', '--dry'], ['remove', 'repo']]) {
    assert.throws(() => parseCommand(argv), /^Error: usage:/)
  }
})

test('a missing layer fails, naming the tag', async () => {
  const fake = fakeRegistry()
  fake.addImage('one', ['base', 'app 1'])
  fake.blobs.delete(digestOf(Buffer.from('base')))
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet }), /^Error: repo:one: blob \w{12} answered 404$/)
})

test('a layer with other content, or another size, fails', async () => {
  const fake = fakeRegistry()
  fake.addImage('one', ['base'])
  fake.blobs.set(digestOf(Buffer.from('base')), Buffer.from('BASE'))
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, log: quiet }), /has other content/)

  const sized = fakeRegistry()
  const layer = sized.addBlob('base')
  sized.addManifest({ config: sized.addBlob('config'), layers: [{ ...layer, size: layer.size + 1 }] }, 'one')
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: sized.registry, log: quiet }), /is 4 bytes, the manifest says 5/)
})

test('a missing manifest fails', async () => {
  const fake = fakeRegistry()
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['gone'], registry: fake.registry, log: quiet }), /repo:gone: manifest gone answered 404/)
})

test('an index is walked down to every image in it, and a missing child fails', async () => {
  const fake = fakeRegistry()
  const first = fake.addImage(null, ['base', 'amd64'])
  const second = fake.addImage(null, ['base', 'attestation'])
  fake.addManifest({ manifests: [{ digest: first }, { digest: second }] }, 'multi')
  const result = await verifyTags({ repository: 'repo', tags: ['multi'], registry: fake.registry, log: quiet })
  assert.equal(result.parts, 5)

  fake.manifests.delete(second)
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['multi'], registry: fake.registry, log: quiet }), /repo:multi: manifest \w{12} answered 404/)
})

test('a manifest by digest whose content is different fails', async () => {
  const fake = fakeRegistry()
  const child = fake.addImage(null, ['base'])
  fake.addManifest({ manifests: [{ digest: child }] }, 'multi')
  fake.manifests.set(child, Buffer.from(JSON.stringify({ config: fake.addBlob('other'), layers: [fake.addBlob('x')] })))
  fake.saidDigest.set(child, null)
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['multi'], registry: fake.registry, log: quiet }), /repo:multi: manifest \w{12} has other content/)
})

test('a manifest with no layers, an empty index, and a repository with no tags all fail', async () => {
  const fake = fakeRegistry()
  fake.addManifest({ config: fake.addBlob('config'), layers: [] }, 'empty')
  fake.addManifest({ manifests: [] }, 'hollow')
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['empty'], registry: fake.registry, log: quiet }), /no config or no layers/)
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['hollow'], registry: fake.registry, log: quiet }), /lists no images/)
  await assert.rejects(verifyTags({ repository: 'repo', tags: [], registry: fake.registry, log: quiet }), /repo has no tags/)
})

test('the live image must be among the tags when its tail is given', async () => {
  const fake = fakeRegistry()
  const digest = fake.addImage('one', ['base'])
  const lines = []
  await verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, expectTail: digest.slice(-12), log: (line) => lines.push(line) })
  assert.match(lines[0], /<- the live image$/)
  await assert.rejects(verifyTags({ repository: 'repo', tags: ['one'], registry: fake.registry, expectTail: '000000000000', log: quiet }), /not the repository the live instance runs on/)
})

test('delete-all refuses the live repository and odd names, before listing anything', () => {
  const never = () => assert.fail('must not be reached')
  assert.throws(() => deleteAllTags({ repository: LIVE_REPOSITORY, list: never, remove: never, log: quiet }), /REFUSED: .* production runs on/)
  assert.throws(() => deleteAllTags({ repository: LIVE_REPOSITORY, dry: true, list: never, remove: never, log: quiet }), /REFUSED/)
  for (const name of ['', 'a b', '../x', 'Repo', 'x:y', undefined]) {
    assert.throws(() => deleteAllTags({ repository: name, list: never, remove: never, log: quiet }), /REFUSED: not a repository name/)
  }
})

test('delete-all deletes every tag of the one repository and nothing else', () => {
  const store = [{ name: 'old', tags: ['a', 'b'] }, { name: LIVE_REPOSITORY, tags: ['wrangler-1'] }, { name: 'older', tags: ['c'] }]
  const removed = []
  const remove = (image) => {
    removed.push(image)
    const [name, tag] = image.split(':')
    const entry = store.find((each) => each.name === name)
    entry.tags = entry.tags.filter((each) => each !== tag)
  }
  const count = deleteAllTags({ repository: 'old', list: () => store.filter((entry) => entry.tags.length), remove, log: quiet })
  assert.equal(count, 2)
  assert.deepEqual(removed, ['old:a', 'old:b'])
  assert.deepEqual(store.find((entry) => entry.name === LIVE_REPOSITORY).tags, ['wrangler-1'])
  assert.deepEqual(store.find((entry) => entry.name === 'older').tags, ['c'])
})

test('delete-all: a dry run deletes nothing, an unknown repository is a no-op, a tag left behind fails', () => {
  const never = () => assert.fail('must not delete')
  const list = () => [{ name: 'old', tags: ['a'] }]
  const lines = []
  assert.equal(deleteAllTags({ repository: 'old', dry: true, list, remove: never, log: (line) => lines.push(line) }), 0)
  assert.deepEqual(lines, ['DRY RUN: would delete 1 tags of old.'])
  assert.equal(deleteAllTags({ repository: 'nowhere', list, remove: never, log: quiet }), 0)
  assert.throws(() => deleteAllTags({ repository: 'old', list, remove: () => {}, log: quiet }), /1 tags of old are still listed/)
  assert.throws(() => deleteAllTags({ repository: 'old', list: () => [{ name: 'old', tags: ['a', '-rf x'] }], remove: never, log: quiet }), /not a plain tag/)
})

test('the image list is read from wrangler output, banner or not', () => {
  const json = JSON.stringify([{ name: 'old', tags: ['a', 'b'] }, { name: 'bare' }])
  assert.deepEqual(parseRepositories('some banner line\n' + json), [{ name: 'old', tags: ['a', 'b'] }, { name: 'bare', tags: [] }])
  assert.throws(() => parseRepositories('Forbidden'), /not JSON/)
})
