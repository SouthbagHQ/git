// /mcp endpoint tests (src/lib/mcp.ts): protocol shape, agent-token auth, the $1 request fee,
// freeze enforcement, and the crash-safety journal (retry replays, pending stays terminal).
// D1 is shimmed over node:sqlite with the real migrations; Identity and Banking are stubbed.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, MCP_REQUEST_FEE_CENTS } from '../src/lib/mcp.ts';

function d1Shim(db) {
  const prepare = sql => ({
    bind(...params) { this.params = params; return this; },
    async first() { return db.prepare(sql).get(...(this.params || [])) ?? null; },
    async all() { return { results: db.prepare(sql).all(...(this.params || [])) }; },
    async run() {
      const r = db.prepare(sql).run(...(this.params || []));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  let queue = Promise.resolve();
  return {
    prepare,
    batch(statements) {
      const result = queue.then(async () => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}

function setup(userId, { frozen = false, identityUnreachable = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').sort()) db.exec(readFileSync('migrations/' + file, 'utf8'));
  db.prepare("INSERT INTO users (id, username, name, created_at, updated_at) VALUES (?, 'ingo', 'Ingo', 0, 0)").run(userId);
  db.prepare("INSERT INTO repos (id, owner_id, name, description, default_branch, network_id, created_at, updated_at) VALUES ('r1', ?, 'portal', 'The portal', 'main', 'n1', 1, 2)").run(userId);
  db.prepare("INSERT INTO requests (id, repo_id, kind, requester_id, reason, status, created_at) VALUES ('q1', 'r1', 'push', ?, 'hotfix', 'open', 3)").run(userId);
  const charges = [];
  const chargedKeys = new Map();
  const env = {
    DB: d1Shim(db),
    IDENTITY_INTERNAL_SECRET: 'bsec',
    IDENTITY_ORIGIN: 'http://identity.test',
    BANKING: {
      async charge(input) {
        // Mirror Banking's idempotency-key dedup: a retried key is a no-op, not a second debit.
        if (input.idempotencyKey && chargedKeys.get(input.idempotencyKey) === input.amount)
          return { balance: 12345, opened: false, duplicate: true };
        if (input.idempotencyKey) chargedKeys.set(input.idempotencyKey, input.amount);
        charges.push(input);
        return { balance: 12345, opened: false, duplicate: false };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (identityUnreachable) throw new Error('connection refused');
    if (String(url).endsWith('/api/internal/agent-token')) {
      const token = JSON.parse(init.body).token;
      if (!String(token).startsWith('good-')) return new Response(JSON.stringify({ error: 'unknown_token' }), { status: 404 });
      return new Response(JSON.stringify({ tokenId: 'tok1', tokenName: 'test', userId, email: `${userId}@x.test`, name: 'Ingo' }), { status: 200 });
    }
    return new Response(JSON.stringify({ frozen, reason: null, frozenAt: null, unfrozenViaFlow: false }), { status: 200 });
  };
  return { db, env, charges, restore: () => { globalThis.fetch = originalFetch; } };
}

const post = (body, headers = {}) => new Request('https://git.southbag.cc/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const auth = { authorization: 'Bearer good-token-1' };
const key = { 'idempotency-key': 'test-key-0001' };
const journal = db => db.prepare('SELECT * FROM mcp_call').all();

test('initialize needs no auth; GET is 405; notifications are 202', async () => {
  const { env, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'initialize')), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.serverInfo.name, 'southbag-git');
  assert.match(body.result.instructions, /\$1\.00 request fee/);
  assert.equal((await handleMcp(new Request('https://git.southbag.cc/mcp'), env)).status, 405);
  assert.equal((await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), env)).status, 202);
  restore();
});

test('tools/list is authenticated but free; tools quote the request fee', async () => {
  const { env, charges, restore } = setup('u1');
  assert.equal((await handleMcp(post(rpc(1, 'tools/list')), env)).status, 401);
  const res = await handleMcp(post(rpc(2, 'tools/list'), auth), env);
  const body = await res.json();
  assert.deepEqual(body.result.tools.map(t => t.name), ['list_repos', 'list_requests']);
  assert.match(body.result.tools[0].description, /\$1\.00/);
  assert.equal(charges.length, 0);
  restore();
});

test('tools/call list_repos charges $1 and returns repos with a receipt', async () => {
  const { db, env, charges, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_repos', arguments: {} }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.repos.length, 1);
  assert.equal(body.result.structuredContent.repos[0].url, '/ingo/portal');
  const receipt = body.result.structuredContent.receipt;
  assert.equal(receipt.requestFee.amount, MCP_REQUEST_FEE_CENTS);
  assert.equal(receipt.balanceAfter, 12345);
  assert.equal(receipt.duplicate, false);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].amount, 100);
  assert.equal(charges[0].idempotencyKey, 'mcp|git|request|u1|test-key-0001');
  assert.equal(journal(db)[0].status, 'done');
  restore();
});

test('a retried Idempotency-Key replays without charging again', async () => {
  const { env, charges, restore } = setup('u1');
  await handleMcp(post(rpc(1, 'tools/call', { name: 'list_requests' }), { ...auth, ...key }), env);
  const res = await handleMcp(post(rpc(2, 'tools/call', { name: 'list_requests' }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.structuredContent.receipt.duplicate, true);
  assert.equal(body.result.structuredContent.requests[0].repo, 'ingo/portal');
  assert.equal(charges.length, 1);
  restore();
});

test('missing/short Idempotency-Key is refused before charging; key reuse across tools or args is a caller bug', async () => {
  const { env, charges, restore } = setup('u1');
  const noKey = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_repos' }), auth), env);
  assert.equal((await noKey.json()).error.code, -32602);
  await handleMcp(post(rpc(2, 'tools/call', { name: 'list_repos', arguments: {} }), { ...auth, ...key }), env);
  const otherTool = await handleMcp(post(rpc(3, 'tools/call', { name: 'list_requests' }), { ...auth, ...key }), env);
  assert.match((await otherTool.json()).error.message, /already used for 'list_repos'/);
  const otherArgs = await handleMcp(post(rpc(4, 'tools/call', { name: 'list_repos', arguments: { limit: 1 } }), { ...auth, ...key }), env);
  assert.match((await otherArgs.json()).error.message, /different arguments/);
  assert.equal(charges.length, 1);
  restore();
});

test('a frozen account is fail-closed: no charge, no journal row', async () => {
  const { db, env, charges, restore } = setup('u1', { frozen: true });
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_repos' }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /frozen/);
  assert.equal(charges.length, 0);
  assert.equal(journal(db).length, 0);
  restore();
});

test('identity unreachable fails closed with no charge', async () => {
  const { env, charges, restore } = setup('u1', { identityUnreachable: true });
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_repos' }), { ...auth, ...key }), env);
  assert.equal(res.status, 503); // token resolution itself fails closed
  assert.equal(charges.length, 0);
  restore();
});

test('a pending row is terminal: never re-run, never reclaimed, then replays once the original lands', async () => {
  const { db, env, charges, restore } = setup('u1');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"arguments":{},"name":"list_repos"}'));
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  db.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES ('u1|test-key-0001', 'u1', 'list_repos', ?, 'pending', ?, ?)")
    .run(hash, Date.now() - 120000, Date.now() - 120000);
  const retry = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_repos' }), { ...auth, ...key }), env);
  const retryBody = await retry.json();
  assert.equal(retryBody.result.structuredContent.unknownOutcome, true);
  assert.equal(charges.length, 0); // no charge, no run
  assert.equal(journal(db)[0].status, 'pending');
  // The original now completes and closes the journal.
  const stored = { content: [{ type: 'text', text: '1 repository.' }], isError: false, structuredContent: { repos: [], receipt: { duplicate: false } } };
  db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = 'u1|test-key-0001'")
    .run(JSON.stringify(stored), Date.now());
  const replay = await handleMcp(post(rpc(2, 'tools/call', { name: 'list_repos' }), { ...auth, ...key }), env);
  assert.equal((await replay.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(charges.length, 0);
  restore();
});
