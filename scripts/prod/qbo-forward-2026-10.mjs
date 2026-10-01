// QuickBooks expenses bill forward: put the covered dates Oct 13 - Nov 13, 2026 on every QuickBooks recurring line of the
// September 2026 DRAFT invoices, and switch those expenses to moving dates so October continues on its own.
// Approved by Alex in chat on 2026-10-01 ("go ahead and adjust the ones that need to be fixed and fix for moving forward").
//
// Default is a TRIAL: everything runs in one transaction and is ROLLED BACK. Pass --apply to commit.
// Usage (repo root): node qbo-forward-apply.mjs <snapshotDir> [--apply] [--include-workforce]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { Pool } = require('pg');
const { coverageLineLabel, DEFAULT_COVERAGE_TEMPLATE } = await import(pathToFileURL(path.join(repo, 'lib', 'expense-coverage.js')).href);
const args = process.argv.slice(2);
const snapshotDir = args.find((a) => !a.startsWith('--'));
if (!snapshotDir) throw new Error('usage: node qbo-forward-apply.mjs <snapshotDir> [--apply] [--include-workforce]');
const apply = args.includes('--apply');
const includeWorkforce = args.includes('--include-workforce');
const vars = JSON.parse(execSync('npx @railway/cli@latest variables --service Postgres --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const pool = new Pool({ connectionString: vars.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });

const PERIOD = '2026-09';
const WINDOW = { start: '2026-10-13', end: '2026-11-13' };
const LEDGER = { start: WINDOW.start, end: WINDOW.end, needsConfirmation: false, reason: null };
const inScope = (d) => /quickbooks|qbo/i.test(d) || (includeWorkforce && /workforce/i.test(d));
const cleanDescription = (d) => String(d).replace(/\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s*[-–]\s*[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s*$/, '').trim();
const cents = (lines) => Math.round(lines.reduce((sum, l) => sum + (Number(l?.amount) || 0), 0) * 100);

const db = await pool.connect();
let committed = false;
try {
  await db.query('begin');
  await db.query("set local lock_timeout = '5s'");
  await db.query("set local statement_timeout = '30s'");
  const inv = (await db.query(`select id, number, status, client_id, line_items, total, updated_at from invoices where period = $1 and status <> 'void' order by number for update`, [PERIOD])).rows;
  const exp = (await db.query(`select * from recurring_reimbursements order by id for update`)).rows;
  const byId = new Map(exp.map((e) => [e.id, e]));

  const invoiceUpdates = new Map(); // invoice id -> new line_items
  const touched = new Map(); // expense id -> { expense, description, template }
  let lineCount = 0;
  for (const invoice of inv) {
    let changed = false;
    const next = invoice.line_items.map((line) => {
      if (line?.kind !== 'recurring') return line;
      let expense = line.recurringId ? byId.get(line.recurringId) : null;
      if (!expense) {
        const owner = line.sourceClientId ?? invoice.client_id;
        const candidates = exp.filter((e) => e.client_id === owner && `Recurring: ${e.description}` === line.label && Number(e.amount) === Number(line.amount));
        if (candidates.length !== 1) return line;
        expense = candidates[0];
      }
      if (!inScope(expense.description)) return line;
      const description = cleanDescription(expense.description);
      const template = String(expense.coverage_template ?? '').trim() || DEFAULT_COVERAGE_TEMPLATE;
      const label = coverageLineLabel({ description, coverageTemplate: template }, WINDOW);
      touched.set(expense.id, { expense, description, template });
      if (line.coverageStart === WINDOW.start && line.coverageEnd === WINDOW.end && line.label === label && line.recurringId === expense.id) return line;
      changed = true;
      lineCount += 1;
      const out = { ...line, label, recurringId: expense.id, coverageStart: WINDOW.start, coverageEnd: WINDOW.end };
      delete out.needsCoverageConfirmation;
      delete out.coverageReason;
      return out;
    });
    if (!changed) continue;
    if (invoice.status !== 'draft') throw new Error(`${invoice.number} is ${invoice.status}, not a draft - refusing to touch it`);
    if (cents(next) !== cents(invoice.line_items) || next.length !== invoice.line_items.length) throw new Error(`${invoice.number}: money or line count would change - refusing`);
    invoiceUpdates.set(invoice.id, { invoice, next });
  }

  const expenseUpdates = [];
  for (const { expense, description, template } of touched.values()) {
    const hist = expense.coverage_history ?? {};
    const earlier = Object.keys(hist).some((k) => /^\d{4}-\d{2}$/.test(k) && k < PERIOD);
    expenseUpdates.push({ expense, description, template, keepSeed: earlier });
  }

  // The undo snapshot: exactly the rows about to change, as they are now.
  const snapshot = {
    takenAt: new Date().toISOString(),
    what: 'QuickBooks recurring lines on September 2026 drafts set to Oct 13 - Nov 13, 2026; expenses switched to moving dates',
    period: PERIOD,
    window: WINDOW,
    includeWorkforce,
    invoices: [...invoiceUpdates.values()].map(({ invoice }) => ({ id: invoice.id, number: invoice.number, status: invoice.status, updated_at: invoice.updated_at, line_items: invoice.line_items })),
    expenses: expenseUpdates.map(({ expense }) => ({ id: expense.id, client_id: expense.client_id, description: expense.description, coverage_enabled: expense.coverage_enabled, coverage_template: expense.coverage_template, coverage_start: expense.coverage_start, coverage_end: expense.coverage_end, coverage_anchor_day: expense.coverage_anchor_day, coverage_history: expense.coverage_history, updated_at: expense.updated_at })),
  };

  for (const { invoice, next } of invoiceUpdates.values()) {
    const r = await db.query(`update invoices set line_items = $2::jsonb, updated_at = now() where id = $1 and status = 'draft'`, [invoice.id, JSON.stringify(next)]);
    if (r.rowCount !== 1) throw new Error(`${invoice.number}: update matched ${r.rowCount} rows`);
  }
  for (const { expense, description, template, keepSeed } of expenseUpdates) {
    const r = await db.query(
      `update recurring_reimbursements
          set coverage_enabled = true,
              coverage_template = $2,
              coverage_start = case when $3::boolean then coverage_start else $4::date end,
              coverage_end = case when $3::boolean then coverage_end else $5::date end,
              coverage_anchor_day = 13,
              coverage_history = jsonb_set(coalesce(coverage_history, '{}'::jsonb), array[$6::text], $7::jsonb, true),
              description = $8,
              updated_at = now()
        where id = $1`,
      [expense.id, template, keepSeed, WINDOW.start, WINDOW.end, PERIOD, JSON.stringify(LEDGER), description],
    );
    if (r.rowCount !== 1) throw new Error(`expense ${expense.id}: update matched ${r.rowCount} rows`);
  }

  // Verify inside the transaction, from what is now stored.
  const after = (await db.query(`select i.number, i.status, i.total, l->>'label' as label, l->>'coverageStart' as cs, l->>'coverageEnd' as ce, l->>'recurringId' as rid from invoices i, jsonb_array_elements(i.line_items) l where i.period = $1 and i.status <> 'void' and l->>'kind' = 'recurring' order by i.number`, [PERIOD])).rows;
  const onWindow = after.filter((r) => r.cs === WINDOW.start && r.ce === WINDOW.end).length;
  const other = after.filter((r) => !(r.cs === WINDOW.start && r.ce === WINDOW.end));
  const expAfter = (await db.query(`select count(*) filter (where coverage_enabled)::int as enabled, count(*) filter (where coverage_history ? $1 and coverage_history->$1->>'start' = $2 and coverage_history->$1->>'end' = $3)::int as ledgered, count(*)::int as total from recurring_reimbursements`, [PERIOD, WINDOW.start, WINDOW.end])).rows[0];
  const totals = (await db.query(`select count(*)::int as n, sum(total)::text as sum from invoices where period = $1 and status <> 'void'`, [PERIOD])).rows[0];
  const totalsBefore = inv.reduce((s, i) => s + Number(i.total), 0).toFixed(2);

  console.log(`${apply ? 'APPLY' : 'TRIAL (will roll back)'} | scope: QuickBooks${includeWorkforce ? ' + Workforce' : ''}`);
  console.log(`invoices changed: ${invoiceUpdates.size} | lines changed: ${lineCount} | expenses changed: ${expenseUpdates.length}`);
  console.log(`recurring lines on ${PERIOD} invoices now: ${after.length} total, ${onWindow} read Oct 13 - Nov 13, ${other.length} other`);
  for (const r of other) console.log(`   other: ${r.number} "${String(r.label).slice(0, 70)}" window ${r.cs ?? '-'}..${r.ce ?? '-'}`);
  console.log(`expenses: ${expAfter.enabled}/${expAfter.total} with moving dates on; ${expAfter.ledgered} carry the September record ${WINDOW.start}..${WINDOW.end}`);
  console.log(`invoice totals: ${totals.n} invoices, sum ${totals.sum} (before: ${totalsBefore})`);
  if (Number(totals.sum).toFixed(2) !== totalsBefore) throw new Error('invoice totals moved - refusing');

  if (apply) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const file = path.join(snapshotDir, `${snapshot.takenAt.replace(/[:.]/g, '-')}-qbo-forward-before.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 1));
    console.log('undo snapshot written:', file);
    await db.query('commit');
    committed = true;
    console.log('COMMITTED');
  } else {
    await db.query('rollback');
    console.log('ROLLED BACK - nothing changed');
  }
} catch (e) {
  if (!committed) await db.query('rollback').catch(() => {});
  console.error('FAILED, nothing changed:', e.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
