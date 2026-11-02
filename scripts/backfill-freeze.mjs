// One-off backfill: report every locally-frozen user to Southbag Identity, which owns the
// account-level freeze now (Git's local users.frozen flag is legacy). Identity's setFrozen is
// idempotent and a completed central unfreeze clears the local flag, so re-running is safe.
//
//   node scripts/backfill-freeze.mjs [--local] [--dry-run]
//
// Reads the D1 database through wrangler (remote by default, --local for the dev database).
// Needs IDENTITY_INTERNAL_SECRET in the environment (Git's entry from Identity's
// INTERNAL_API_SECRETS, key "southbag-git"); IDENTITY_ORIGIN overrides the default.
import { execSync } from 'node:child_process';

const local = process.argv.includes('--local');
const dryRun = process.argv.includes('--dry-run');
const secret = process.env.IDENTITY_INTERNAL_SECRET;
const origin = process.env.IDENTITY_ORIGIN || 'https://identity.southbag.cc';
if (!secret && !dryRun) {
  console.error('IDENTITY_INTERNAL_SECRET is required (or use --dry-run)');
  process.exit(1);
}

const sql = "SELECT id, frozen_reason FROM users WHERE frozen = 1";
const out = execSync(
  `npx wrangler d1 execute DB ${local ? '--local' : '--remote'} --json --command "${sql}"`,
  { encoding: 'utf8' }
);
const rows = JSON.parse(out).flatMap(r => r.results || []);
console.log(`${rows.length} locally frozen users`);
let failed = 0;
for (const row of rows) {
  const reason = row.frozen_reason || 'Account frozen (pre-existing local freeze)';
  if (dryRun) { console.log(`would report ${row.id}: ${reason}`); continue; }
  const response = await fetch(`${origin}/api/internal/freeze`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: row.id, reason, origin: 'git-backfill' }),
  });
  if (!response.ok) { failed++; console.error(`${row.id}: identity answered ${response.status}`); }
  else console.log(`${row.id}: reported`);
}
if (failed) { console.error(`${failed} reports failed - re-run to retry`); process.exit(1); }
console.log('backfill complete');
