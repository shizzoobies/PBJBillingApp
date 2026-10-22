import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dumpArgs } from '../scripts/migrate/dump.mjs'

// The nightly backup failed 48 nights running because its secrets were never
// set and nothing said so. These pin the parts that make it fail LOUDLY.
const read = (file) => readFileSync(path.resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github/workflows/db-backup.yml')
const script = read('scripts/db-backup.sh')
const SECRETS = ['BACKUP_DATABASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']

describe('db-backup workflow', () => {
  it('checks all five secrets, by name, before it installs or dumps anything', () => {
    const check = workflow.indexOf('Check that every required secret is set')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(workflow.indexOf('Install postgresql-client'))
    expect(check).toBeLessThan(workflow.indexOf('run: bash scripts/db-backup.sh'))
    const step = workflow.slice(check, workflow.indexOf('Install postgresql-client'))
    for (const name of SECRETS) {
      expect(step).toContain(`${name}: \${{ secrets.${name} }}`)
      expect(step).toContain(name)
    }
    expect(step).toContain('::error title=Backup secret missing::')
    expect(step).toContain('exit 1')
    expect(step).toContain('GITHUB_STEP_SUMMARY')
  })

  it('dumps from BACKUP_DATABASE_URL and no longer reads the dead Railway proxy secret', () => {
    expect(workflow).toContain('BACKUP_DATABASE_URL: ${{ secrets.BACKUP_DATABASE_URL }}')
    expect(workflow).not.toMatch(/secrets\.DATABASE_PUBLIC_URL/)
    expect(script).toContain('--dbname="$BACKUP_DATABASE_URL"')
    expect(script).not.toMatch(/\bDATABASE_PUBLIC_URL\b/)
  })

  it('keeps the schedule, the manual trigger and the restore drill', () => {
    expect(workflow).toContain("cron: '15 8 * * *'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('restore-drill:')
    expect(workflow).toContain('bash scripts/db-restore-drill.sh')
  })

  it('the script re-checks its secrets, names the date in the key, and confirms the upload', () => {
    for (const name of SECRETS) expect(script).toContain(name)
    expect(script).toContain('DUMP_NAME="pbj-${STAMP}.dump"')
    expect(script).toContain('daily/${DUMP_NAME}')
    expect(script).toContain('head-object')
    expect(script).toContain('R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"')
  })

  it('never publishes the dump as a GitHub artifact (the repository is public)', () => {
    expect(workflow).not.toMatch(/upload-artifact|download-artifact/)
    // The drill fetches the object the backup job uploaded, from R2.
    const drill = workflow.slice(workflow.indexOf('restore-drill:'))
    expect(drill).toContain('aws s3 cp "s3://${R2_BUCKET}/daily/${DUMP_NAME}"')
    expect(drill).toContain('DUMP_NAME: ${{ needs.backup.outputs.dump_name }}')
    expect(workflow).toContain('run_restore_drill:')
    expect(workflow).toMatch(/run_restore_drill:[\s\S]*?default: false/)
  })

  it('dumps with the same flags as scripts/migrate/dump.mjs, and masks host, user and password', () => {
    for (const flag of dumpArgs('x').filter((arg) => arg.startsWith('--'))) expect(script).toContain(flag)
    expect(script).toContain('u.hostname, u.username, u.password')
    expect(script).toContain('decodeURIComponent(u.password)')
  })

  it('a failed prune is a warning, not a failed backup', () => {
    expect(script).toMatch(/prune_prefix "daily\/" 30 \|\| echo "::warning::/)
    expect(script).toMatch(/prune_prefix "monthly\/" 365 \|\| echo "::warning::/)
  })
})
