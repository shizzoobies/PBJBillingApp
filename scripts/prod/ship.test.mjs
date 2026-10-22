import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const ship = fileURLToPath(new URL('./ship.sh', import.meta.url))
const sha = 'abcdef01234567890123456789012345678901234'
const base = '1111111111111111111111111111111111111111'

function scenario(t, kind) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-ship-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const put = (name, body) => writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + body, { mode: 0o755 })
  put('git', 'echo "git $*" >> "$TRACE"\n' + [
    'case "$1 $2" in',
    ' "rev-parse --show-toplevel") printf "%s\\n" "$FIXTURE_ROOT";;',
    ' "branch --show-current") if [ "$SCENARIO" = branch ]; then echo feature; else echo main; fi;;',
    ' "status --porcelain") if [ "$SCENARIO" = dirty ]; then echo " M file"; fi;;',
    ' "rev-parse --verify") echo "$TARGET_SHA";;',
    ' "rev-parse refs/heads/main") if [ "$SCENARIO" = ahead ]; then echo "$TARGET_SHA"; else echo "$BASE_SHA"; fi;;',
    ' "rev-parse refs/remotes/origin/main") echo "$BASE_SHA";;',
    ' "merge-base --is-ancestor") [ "$SCENARIO" != diverged ];;',
    ' "rev-list --count") echo 1;;',
    ' "push origin") [ "$SCENARIO" != push_fail ];;',
    ' "fetch -q"|"merge --ff-only") exit 0;;',
    ' *) echo "unexpected fake git command" >&2; exit 9;;',
    'esac',
  ].join('\n'))
  put('node', [
    'case "$1" in',
    ' scripts/prod/quiet-check.mjs) echo quiet >> "$TRACE"; [ "$SCENARIO" != busy ];;',
    ' scripts/cf/tail.mjs) echo tail >> "$TRACE";;',
    ' *) exec "$REAL_NODE" "$@";;',
    'esac',
  ].join('\n'))
  put('gh', [
    'echo "gh $*" >> "$TRACE"',
    'if [ "$2" = list ]; then',
    ' if [ "$SCENARIO" = list_fail ]; then exit 1; fi',
    ' if [ "$SCENARIO" = no_run ]; then echo "[]"; else echo \'[{"databaseId":123}]\'; fi',
    'else [ "$SCENARIO" != workflow_fail ]; fi',
  ].join('\n'))
  put('curl', [
    'echo curl >> "$TRACE"',
    'if [ "$SCENARIO" = http_fail ]; then exit 22; fi',
    'if [ "$SCENARIO" = stale ]; then echo \'{"commit":"0000000","ok":true}\';',
    'elif [ "$SCENARIO" = unhealthy ]; then echo \'{"commit":"abcdef0","ok":false}\';',
    'else echo \'{"commit":"abcdef0","ok":true}\'; fi',
  ].join('\n'))
  put('sleep', 'exit 0\n')
  // Exercise the actual shell code with two retries instead of 40. Every
    // parser, command and guard is unchanged; only waiting duration is shortened.
    const scriptText = readFileSync(ship, 'utf8')
    assert.equal((scriptText.match(/i<=40/g) || []).length, 2)
    const fixtureShip = path.join(dir, 'ship.sh')
    writeFileSync(fixtureShip, scriptText.replaceAll('i<=40', 'i<=2').replaceAll('\r\n', '\n'))
    const trace = path.join(dir, 'trace')
  const toUnix = (s) => s.replaceAll('\\', '/')
  const driver = process.platform === 'win32'
    ? 'export PATH="$(cygpath -u "$FIXTURE_BIN"):$PATH"; exec bash "$SHIP_SCRIPT" "$TARGET_SHA"'
    : 'export PATH="$FIXTURE_BIN:$PATH"; exec bash "$SHIP_SCRIPT" "$TARGET_SHA"'
  const result = spawnSync(bash, ['-c', driver], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SCENARIO: kind, TARGET_SHA: sha, BASE_SHA: base,
      FIXTURE_BIN: toUnix(bin), FIXTURE_ROOT: toUnix(dir), TRACE: toUnix(trace),
      REAL_NODE: toUnix(process.execPath), SHIP_SCRIPT: toUnix(fixtureShip) },
  })
  assert.ifError(result.error)
  return { ...result, trace: existsSync(trace) ? readFileSync(trace, 'utf8') : '' }
}

for (const kind of ['success', 'ahead']) {
  test('ship accepts verified workflow and healthy exact commit: ' + kind, { skip: !existsSync(bash) }, (t) => {
    const result = scenario(t, kind)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.trace, /gh run watch 123 --exit-status/)
    assert.match(result.trace, /tail/)
    assert.match(result.stdout, /ALL SHIPPED/)
  })
}
for (const kind of ['branch', 'dirty', 'diverged', 'busy', 'push_fail', 'list_fail', 'no_run', 'workflow_fail', 'http_fail', 'stale', 'unhealthy']) {
  test('ship stops on ' + kind, { skip: !existsSync(bash) }, (t) => {
    const result = scenario(t, kind)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /ALL SHIPPED/)
    assert.doesNotMatch(result.trace, /tail/)
    if (['branch', 'dirty', 'diverged', 'busy'].includes(kind)) assert.doesNotMatch(result.trace, /git push/)
    if (kind === 'push_fail') assert.doesNotMatch(result.trace, /gh run/)
    if (['list_fail', 'no_run', 'workflow_fail'].includes(kind)) assert.doesNotMatch(result.trace, /curl/)
  })
}
