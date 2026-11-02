// Tests for the account-level freeze client (src/lib/identity.ts): fresh (uncached) status checks,
// fail-CLOSED when Identity is unreachable or rejects the secret, local-flag reconciliation, and
// the durable freeze-report queue.
// Runs on node --test with type stripping; no wrangler needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCentralFreeze, enqueueFreezeReport, flushFreezeReports, getCentralFreeze,
} from '../src/lib/identity.ts';

function fakeDb(statements = []) {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      return {
        bind(...params) { runs.push([sql, params]); return this; },
        async run() { return {}; },
        async first() { return null; },
        async all() { return { results: statements.shift() ?? [] }; },
      };
    },
  };
}

const envWith = (secret, db = fakeDb()) => ({ IDENTITY_INTERNAL_SECRET: secret, DB: db });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

const frozenUser = () => ({ id: 'u1', username: 'u', name: 'U', email: null, bio: '', created_at: 0, frozen: 1, frozen_reason: 'Force push', frozen_at: 1, security_question: 'ceo', security_streak: 1 });
const cleanUser = () => ({ ...frozenUser(), frozen: 0, frozen_reason: null, frozen_at: null, security_question: null, security_streak: 0 });

test('unconfigured secret means unknown - local flag only', async () => {
  assert.equal(await getCentralFreeze(envWith(''), 'u1'), null);
  const user = frozenUser();
  await applyCentralFreeze(envWith(''), 'u1' && user);
  assert.equal(user.frozen, 1, 'local flag untouched');
});

test('central freeze marks the in-memory user frozen without touching the local row', async () => {
  const db = fakeDb();
  const fetcher = async () => jsonResponse({ frozen: true, reason: 'Loan default', frozenAt: 42, unfrozenViaFlow: false });
  const user = cleanUser();
  await applyCentralFreeze(envWith('s', db), user, fetcher);
  assert.equal(user.frozen, 1);
  assert.equal(user.frozen_reason, 'Loan default');
  assert.deepEqual(db.runs, [], 'no local writes for a central freeze');
});

test('a completed central unfreeze clears the legacy local flag', async () => {
  const db = fakeDb();
  const fetcher = async () => jsonResponse({ frozen: false, reason: null, frozenAt: null, unfrozenViaFlow: true });
  const user = frozenUser();
  await applyCentralFreeze(envWith('s', db), user, fetcher);
  assert.equal(user.frozen, 0);
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0][0], /UPDATE users SET frozen = 0/);
});

test('not-frozen centrally with no unfreeze cycle keeps a legacy local freeze', async () => {
  const db = fakeDb();
  const fetcher = async () => jsonResponse({ frozen: false, reason: null, frozenAt: null, unfrozenViaFlow: false });
  const user = frozenUser();
  await applyCentralFreeze(envWith('s', db), user, fetcher);
  assert.equal(user.frozen, 1, 'pre-backfill local freeze stands');
  assert.deepEqual(db.runs, []);
});

test('identity unreachable but configured: refuse actions until it answers (conservative)', async () => {
  const db = fakeDb();
  const fetcher = async () => { throw new Error('connection refused'); };
  const status = await getCentralFreeze(envWith('s', db), 'u1', fetcher);
  assert.equal(status.unavailable, true);
  const user = cleanUser();
  await applyCentralFreeze(envWith('s', db), user, fetcher);
  assert.equal(user.frozen, 1, 'unknown is not safe: actions refused while Identity is down');
  assert.equal(user.central_unavailable, 1);
});

test('identity rejecting the secret: unavailable (fail closed) with a distinct loud log', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const fetcher = async () => jsonResponse({}, 403);
    const status = await getCentralFreeze(envWith('s'), 'u1', fetcher);
    assert.equal(status.unavailable, true, 'rejected secret fails closed');
  } finally { console.error = originalError; }
  assert.ok(errors.some(line => /REJECTED the configured secret/.test(line)), 'secret rejection logged distinctly');
});

test('identity unconfigured: central check off, local flags only (development)', async () => {
  const user = cleanUser();
  await applyCentralFreeze({}, user);
  assert.equal(user.frozen, 0);
  assert.equal(user.central_unavailable, 0);
});

test('status responses are NOT cached - a cached active answer is an authorization window', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return jsonResponse({ frozen: false, reason: null, frozenAt: null, unfrozenViaFlow: false }); };
  const env = envWith('s');
  await getCentralFreeze(env, 'u1', fetcher);
  await getCentralFreeze(env, 'u1', fetcher);
  assert.equal(calls, 2, 'every check fetches fresh');
});

test('freeze reports queue durably and flush marks them; failures stay queued', async () => {
  const db = fakeDb([[{ user_id: 'u1', reason: 'Git fraud detection (Force push)' }]]);
  await enqueueFreezeReport(envWith('s', db), 'u1', 'Git fraud detection (Force push)');
  assert.match(db.runs[0][0], /INSERT INTO identity_freeze_outbox/);
  let calls = 0;
  const ok = async () => { calls++; return jsonResponse({ frozen: true }); };
  await flushFreezeReports(envWith('s', db), ok);
  assert.equal(calls, 1);
  assert.match(db.runs.at(-1)[0], /UPDATE identity_freeze_outbox SET reported_at/);
  // Failing fetch: no reported_at write.
  const db2 = fakeDb([[{ user_id: 'u2', reason: 'x' }]]);
  const failing = async () => { throw new Error('down'); };
  await flushFreezeReports(envWith('s', db2), failing);
  assert.equal(db2.runs.filter(([sql]) => sql.includes('reported_at = ?')).length, 0, 'still queued');
  // Unconfigured: nothing is sent.
  const db3 = fakeDb([]);
  await flushFreezeReports(envWith('', db3));
  assert.deepEqual(db3.runs, []);
});
