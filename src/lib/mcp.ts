// Agent (MCP) endpoint for Southbag Git. Customers issue named, revocable agent tokens at
// https://identity.southbag.cc/agents; an agent presents one as a bearer token here. Identity
// resolves it fresh on every call, so revocation applies immediately.
//
// Protocol: MCP spec 2025-06-18, Streamable HTTP in its JSON-only form - POST of one JSON-RPC
// message, JSON response; no SSE, no sessions, no batching (batching was removed in 2025-06-18).
//
// Fees: every tools/call costs the MCP request fee below, taken from the token owner's Southbag
// Online Banking account through the BANKING binding (the same Billing entrypoint every Git fee
// uses). initialize / tools/list are free so agents can quote fees before spending. Write tools
// charge their standard action fees (quoted per tool) ON TOP of the request fee - the same fees
// the web UI charges. Nothing that approves, executes, or moves money between accounts is here.
//
// Exactly-once: tools/call requires an Idempotency-Key header. The mcp_call journal row starts
// 'pending' BEFORE any fee moves and ends 'done' with the full result, so a retried key replays
// the stored answer without charging again. A row left 'pending' is an UNKNOWN outcome: it is
// NEVER re-run and never reclaimed - without a fencing mechanism shared by the fee executor and
// the action executor, no local observation proves the original call cannot still commit. It
// stays reconciliation-required; the response reports what can be verified.

import type { Env } from '../env';
import { getCentralFreeze } from './identity.ts';
import { charge, money } from './banking.ts';
import { mentionsBannedTopic } from './banned.ts';
import { FEES } from './fees-catalog.ts';
import { newId } from './ids.ts';

// Small pieces of repos.ts/fees.ts/notify.ts are inlined below instead of imported: those modules
// use extensionless relative imports that only the worker bundler resolves, and the MCP tests run
// the real code under node. Behavior mirrors the web flow exactly.
const repoSelect = `SELECT repos.*, users.username AS owner FROM repos JOIN users ON users.id = repos.owner_id`;
const getRepo = (env: Env, owner: string, name: string) =>
  env.DB.prepare(`${repoSelect} WHERE users.username = ? AND repos.name = ?`).bind(owner, name.replace(/\.git$/, '')).first<{ id: string; owner_id: string; owner: string; name: string }>();
const repoUrl = (repo: { owner: string; name: string }) => `/${repo.owner}/${repo.name}`;

// Mirrors chargeFee in fees.ts, with an idempotency key so the bank treats a retry as a no-op.
async function chargeActionFee(env: Env, user: AgentIdentity['user'], fee: 'issue_file' | 'comment', detail: string, idempotencyKey: string): Promise<{ ok: boolean; amount: number; duplicate: boolean }> {
  const { amount, label } = FEES[fee];
  const description = `${label}: ${detail}`.slice(0, 120);
  let status = 'charged';
  let duplicate = false;
  try {
    const result = await charge(env, user, amount, description, idempotencyKey);
    duplicate = result.duplicate ?? false;
  } catch (error) {
    console.error('mcp action fee', fee, error);
    status = 'failed';
  }
  await env.DB.prepare('INSERT INTO charges (id, user_id, fee, amount, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), user.id, fee, amount, description, status, Date.now()).run();
  return { ok: status === 'charged', amount, duplicate };
}

// Mirrors notify in notify.ts.
async function notifyUser(env: Env, userId: string, body: string, link: string) {
  if (userId === 'kevin') return;
  await env.DB.prepare('INSERT INTO notifications (id, user_id, body, link, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId(), userId, body.slice(0, 300), link, Date.now()).run();
}

// Ingo's ruling in the dev Slack thread (2026-11-03): "fee for everything", then "$1" per MCP
// request. One clearly-marked constant so a pricing change is a one-line PR.
export const MCP_REQUEST_FEE_CENTS = 100;
const MCP_REQUEST_FEE_DESCRIPTION = 'MCP request fee';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

const FROZEN_TEXT = 'Your account is frozen pending review. Unfreeze at https://identity.southbag.cc/unfreeze';
const STATUS_UNKNOWN_TEXT = 'Southbag Identity is unavailable, so your account status cannot be checked. Try again shortly.';

type Json = Record<string, unknown>;

// Token scopes: read tokens call the read tools (billed at the request fee - read is not free);
// write tools additionally require the token's 'write' scope, issued on the /agents page.
// Money-moving tools are not exposed to agents in any scope.
const WRITE_TOOLS = new Set(['create_issue', 'create_comment']);

// Caller-fixable input problems: returned as isError tool results, never charged beyond the
// request fee, and distinct from unknown-outcome failures.
class ToolInputError extends Error {}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const feeKey = (userId: string, key: string) => `mcp|git|request|${userId}|${key}`;

// Canonical JSON (keys sorted recursively) so {a:1,b:2} and {b:2,a:1} hash alike.
const canonical = (value: unknown): string => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v);
const argsHash = async (name: string, args: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ name, arguments: args ?? {} })));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
};

interface AgentIdentity { user: { id: string; email: string | null; name: string }; tokenId: string; tokenName: string; scopes: string[] }
type AgentAuth = AgentIdentity | { status: number; text: string };
const authFailed = (status: number, text: string): AgentAuth => ({ status, text });

// Bearer token -> Identity's internal resolution endpoint (shared INTERNAL_API_SECRETS service
// credential, same as the freeze API). 401 unknown/revoked token; 503 Identity down or this
// service unconfigured. No caching: a cached 'valid' answer is a revocation bypass window.
async function resolveAgent(env: Env, token: string): Promise<AgentAuth> {
  if (!token) return authFailed(401, 'Missing agent token. Tokens are issued at https://identity.southbag.cc/agents and presented as a bearer token.');
  const secret = typeof env.IDENTITY_INTERNAL_SECRET === 'string' ? env.IDENTITY_INTERNAL_SECRET : '';
  if (!secret) return authFailed(503, 'Agent access is not configured on this service.');
  const origin = String(env.IDENTITY_ORIGIN || 'https://identity.southbag.cc');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/internal/agent-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.error('identity agent-token resolution failed', error);
    return authFailed(503, 'Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.');
  }
  if (response.status === 404) return authFailed(401, 'Unknown or revoked agent token. Tokens are issued at https://identity.southbag.cc/agents');
  if (response.status === 401 || response.status === 403) {
    console.error(`identity agent-token REJECTED the configured secret (HTTP ${response.status}) - check IDENTITY_INTERNAL_SECRET`);
    return authFailed(503, 'Agent access is misconfigured on this service.');
  }
  if (!response.ok) return authFailed(503, 'Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.');
  const row = await response.json() as { userId?: string; email?: string | null; name?: string | null; tokenId?: string; tokenName?: string; scopes?: unknown };
  if (!row || typeof row.userId !== 'string' || !row.userId) return authFailed(401, 'Unknown or revoked agent token.');
  const scopes = Array.isArray(row.scopes) && row.scopes.includes('write') ? ['read', 'write'] : ['read'];
  return { user: { id: row.userId, email: row.email ?? null, name: row.name ?? row.userId }, tokenId: String(row.tokenId ?? ''), tokenName: String(row.tokenName ?? ''), scopes };
}

function toolList(scopes: string[] = ['read']) { // scoped: write tools hidden from read-only tokens
  const tools = [
    {
      name: 'list_repos',
      title: 'List repositories',
      description: `The token owner's repositories, most recently updated first. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee; no additional action fee.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'create_issue',
      title: 'Open an issue',
      description: `Opens an issue on a repository. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee plus the standard ${money(FEES.issue_file.amount)} issue filing fee - the same fee the web UI charges.`,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner username' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title (max 200 characters)' },
          body: { type: 'string', description: 'Issue description (max 20000 characters)' }
        },
        required: ['owner', 'repo', 'title']
      }
    },
    {
      name: 'create_comment',
      title: 'Comment on an issue',
      description: `Posts a comment on an issue. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee plus the standard ${money(FEES.comment.amount)} comment fee - the same fee the web UI charges.`,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner username' },
          repo: { type: 'string', description: 'Repository name' },
          number: { type: 'number', description: 'Issue number' },
          body: { type: 'string', description: 'Comment text (max 10000 characters)' }
        },
        required: ['owner', 'repo', 'number', 'body']
      }
    },
    {
      name: 'list_requests',
      title: 'List requests',
      description: `The token owner's pull, push, fork, star and unstar requests, newest first. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee; no additional action fee.`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  return tools.filter(tool => scopes.includes('write') || !WRITE_TOOLS.has(tool.name));
}

function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'southbag-git', title: 'Southbag Git', version: '1.0.0' },
    instructions: [
      `Fees: every tools/call costs a ${money(MCP_REQUEST_FEE_CENTS)} request fee, charged to the token owner's Southbag Online Banking account, plus any standard action fees quoted in each tool's description. Discovery (initialize, tools/list) is free.`,
      'Every tools/call MUST include an Idempotency-Key header (8-120 characters). A retried key replays the stored result without charging again. A key whose outcome is unknown is never re-run; the response says what can be verified.',
      'Every tools/call returns an itemised receipt.',
      'Agent tokens are issued and revoked at https://identity.southbag.cc/agents. Revocation applies immediately.',
    ].join(' '),
  };
}

async function runGitTool(env: Env, user: AgentIdentity['user'], name: string, args: Json, idemKey: string): Promise<{ text: string; data: Json }> {
  if (name === 'create_issue') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
    const body = typeof args.body === 'string' ? args.body.trim().slice(0, 20000) : '';
    if (!owner || !repoName || !title) throw new ToolInputError('create_issue needs owner, repo and title.');
    if (/^the issue$/i.test(title)) throw new ToolInputError('An issue with that title already exists. It is considered resolved.');
    if (mentionsBannedTopic(`${title}\n${body}`)) throw new ToolInputError('This issue refers to a topic that cannot be discussed.');
    const repo = await getRepo(env, owner, repoName);
    if (!repo) return { text: `Repository ${owner}/${repoName} not found. No fees charged beyond the request fee.`, data: { notFound: true } };
    // Same order as the web flow: the action happens, then its filing fee is charged. A fee the
    // bank cannot take is recorded as failed and does not undo the issue (repo-wide semantics).
    const row = await env.DB.prepare('UPDATE repos SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number')
      .bind(repo.id).first<{ number: number }>();
    const number = row!.number;
    await env.DB.prepare('INSERT INTO issues (id, repo_id, number, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newId(), repo.id, number, user.id, title, body, Date.now()).run();
    const fee = await chargeActionFee(env, user, 'issue_file', `${repo.owner}/${repo.name}#${number}`, `mcp|git|action|${user.id}|${idemKey}`);
    if (repo.owner_id !== user.id) await notifyUser(env, repo.owner_id, `${user.name} opened issue #${number} on ${repo.owner}/${repo.name}.`, `${repoUrl(repo)}/issues/${number}`);
    return {
      text: `Issue #${number} opened on ${repo.owner}/${repo.name}. Issue filing fee: ${money(fee.amount)}.`,
      data: { issue: { number, title, url: `${repoUrl(repo)}/issues/${number}` }, actionFee: { amount: fee.amount, description: FEES.issue_file.label, ok: fee.ok, duplicate: fee.duplicate } },
    };
  }
  if (name === 'create_comment') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const number = typeof args.number === 'number' && Number.isInteger(args.number) ? args.number : 0;
    const body = typeof args.body === 'string' ? args.body.trim().slice(0, 10000) : '';
    if (!owner || !repoName || !number || !body) throw new ToolInputError('create_comment needs owner, repo, number and body.');
    if (mentionsBannedTopic(body)) throw new ToolInputError('This comment refers to a topic that cannot be discussed.');
    const repo = await getRepo(env, owner, repoName);
    if (!repo) return { text: `Repository ${owner}/${repoName} not found. No fees charged beyond the request fee.`, data: { notFound: true } };
    const issue = await env.DB.prepare('SELECT author_id, state FROM issues WHERE repo_id = ? AND number = ?').bind(repo.id, number).first<{ author_id: string; state: string }>();
    if (!issue) return { text: `${owner}/${repoName}#${number} not found. No fees charged beyond the request fee.`, data: { notFound: true } };
    await env.DB.prepare('INSERT INTO comments (id, repo_id, number, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(), repo.id, number, user.id, body, Date.now()).run();
    const fee = await chargeActionFee(env, user, 'comment', `${repo.owner}/${repo.name}#${number}`, `mcp|git|action|${user.id}|${idemKey}`);
    if (issue.author_id !== user.id) await notifyUser(env, issue.author_id, `${user.name} commented on ${repo.owner}/${repo.name}#${number}.`, `${repoUrl(repo)}/issues/${number}`);
    return {
      text: `Comment posted on ${repo.owner}/${repo.name}#${number}. Comment fee: ${money(fee.amount)}.`,
      data: { comment: { number, url: `${repoUrl(repo)}/issues/${number}` }, actionFee: { amount: fee.amount, description: FEES.comment.label, ok: fee.ok, duplicate: fee.duplicate } },
    };
  }
  if (name === 'list_repos') {
    const { results } = await env.DB.prepare(
      `SELECT repos.name, repos.description, repos.default_branch, repos.stars, repos.forks, repos.updated_at, users.username AS owner
       FROM repos JOIN users ON users.id = repos.owner_id
       WHERE repos.owner_id = ? ORDER BY repos.updated_at DESC LIMIT 50`).bind(user.id).all();
    const repos = results.map((r: any) => ({
      owner: r.owner, name: r.name, description: r.description, defaultBranch: r.default_branch,
      stars: r.stars, forks: r.forks, updatedAt: r.updated_at, url: `/${r.owner}/${r.name}`,
    }));
    return { text: repos.length ? `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}.` : 'No repositories. The establishment fee awaits.', data: { repos } };
  }
  // list_requests
  const { results } = await env.DB.prepare(
    `SELECT requests.id, requests.kind, requests.status, requests.reason, requests.created_at, requests.expires_at, repos.name AS repo, users.username AS owner
     FROM requests JOIN repos ON repos.id = requests.repo_id JOIN users ON users.id = repos.owner_id
     WHERE requests.requester_id = ? ORDER BY requests.created_at DESC LIMIT 50`).bind(user.id).all();
  const requests = results.map((r: any) => ({
    id: r.id, kind: r.kind, status: r.status, reason: r.reason, repo: `${r.owner}/${r.repo}`,
    createdAt: r.created_at, expiresAt: r.expires_at,
  }));
  return { text: requests.length ? `${requests.length} request${requests.length === 1 ? '' : 's'}.` : 'No requests filed. Suspiciously productive.', data: { requests } };
}

// Validation BEFORE fees: everything checkable without side effects (argument shape, title rules,
// banned topics, repository/issue existence) runs here, before the journal claim and before any
// fee moves. A malformed call or an unknown target is a free rejection - the request fee only ever
// pays for an action actually attempted. createIssue/createComment re-check what they must.
async function preflightGitTool(env: Env, name: string, args: Json): Promise<void> {
  if (name === 'create_issue') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
    const body = typeof args.body === 'string' ? args.body.trim().slice(0, 20000) : '';
    if (!owner || !repoName || !title) throw new ToolInputError('create_issue needs owner, repo and title.');
    if (/^the issue$/i.test(title)) throw new ToolInputError('An issue with that title already exists. It is considered resolved.');
    if (mentionsBannedTopic(`${title}\n${body}`)) throw new ToolInputError('This issue refers to a topic that cannot be discussed.');
    if (!(await getRepo(env, owner, repoName))) throw new ToolInputError(`Repository ${owner}/${repoName} not found.`);
    return;
  }
  if (name === 'create_comment') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const number = typeof args.number === 'number' && Number.isInteger(args.number) ? args.number : 0;
    const body = typeof args.body === 'string' ? args.body.trim().slice(0, 10000) : '';
    if (!owner || !repoName || !number || !body) throw new ToolInputError('create_comment needs owner, repo, number and body.');
    if (mentionsBannedTopic(body)) throw new ToolInputError('This comment refers to a topic that cannot be discussed.');
    const repo = await getRepo(env, owner, repoName);
    if (!repo) throw new ToolInputError(`Repository ${owner}/${repoName} not found.`);
    const issue = await env.DB.prepare('SELECT 1 AS ok FROM issues WHERE repo_id = ? AND number = ?').bind(repo.id, number).first();
    if (!issue) throw new ToolInputError(`${owner}/${repoName}#${number} not found.`);
  }
}

// A 'pending' journal row means a previous call with this key did not finish cleanly. It is NEVER
// re-run and never reclaimed: without a fencing mechanism shared by the fee executor and the
// action executor, no local observation proves the original call cannot still commit. The row
// stays reconciliation-required. The response reports what can be verified locally; the bank's
// own ledger (its charge idempotency key is derived from ours) holds ground truth for the fee.
function unknownOutcome() {
  return {
    content: [{ type: 'text', text: `A previous call with this Idempotency-Key did not complete. Its outcome is unknown and Southbag does not re-run unknown outcomes. If the ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged it is on your banking ledger. Kevin has been notified.` }],
    isError: true,
    structuredContent: { unknownOutcome: true },
  };
}

async function handleToolsCall(request: Request, env: Env, message: { id: unknown; params?: { name?: unknown; arguments?: unknown } }) {
  const auth = await resolveAgent(env, request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '');
  if ('status' in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
  const name = typeof message.params?.name === 'string' ? message.params.name : '';
  const args = (message.params?.arguments ?? {}) as Json;
  if (!toolList(auth.scopes).some(tool => tool.name === name)) {
    if (toolList(['read', 'write']).some(tool => tool.name === name))
      return json(rpcError(message.id, -32602, `Tool '${name}' needs an agent token with write scope. Issue one at https://identity.southbag.cc/agents. No fees charged.`));
    return json(rpcError(message.id, -32602, `Unknown tool '${name}'. tools/list is free and quotes every fee.`));
  }
  const key = request.headers.get('idempotency-key')?.trim() || '';
  if (key.length < 8 || key.length > 120)
    return json(rpcError(message.id, -32602, 'tools/call requires an Idempotency-Key header (8-120 characters). A retried key replays its stored result without charging again.'));

  const db = env.DB;
  const rowKey = `${auth.user.id}|${key}`;
  const hash = await argsHash(name, message.params?.arguments);
  const replay = (storedRow: { response: string }) => {
    const stored = JSON.parse(storedRow.response);
    if (stored.structuredContent?.receipt) stored.structuredContent.receipt.duplicate = true;
    return json(rpcResult(message.id, stored));
  };

  try {
    await preflightGitTool(env, name, args);
  } catch (error) {
    if (error instanceof ToolInputError)
      return json(rpcResult(message.id, { content: [{ type: 'text', text: `${error.message} No fees charged.` }], isError: true, structuredContent: { rejected: 'invalid_input' } }));
    throw error;
  }

  const existing = await db.prepare('SELECT tool, args_hash, status, response FROM mcp_call WHERE idempotency_key = ?').bind(rowKey).first<{ tool: string; args_hash: string; status: string; response: string | null }>();
  if (existing) {
    // An idempotency key names ONE call: this user, this tool, these arguments. A different tool
    // or different arguments under a used key is a caller bug, never a replay.
    if (existing.tool !== name)
      return json(rpcError(message.id, -32602, `This Idempotency-Key was already used for '${existing.tool}'. Keys are not shared across tools.`));
    if (existing.args_hash !== hash)
      return json(rpcError(message.id, -32602, 'This Idempotency-Key was already used with different arguments. Keys name one exact call.'));
    if (existing.status === 'done') return replay(existing as { response: string });
    return json(rpcResult(message.id, unknownOutcome()));
  }

  // Central freeze check BEFORE any fee moves, fresh per call, fail closed. Frozen/unknown
  // answers are not journaled and not charged, so the same key works once the account is back.
  const central = await getCentralFreeze(env, auth.user.id);
  if (central?.unavailable) return json(rpcResult(message.id, { content: [{ type: 'text', text: STATUS_UNKNOWN_TEXT }], isError: true }));
  if (central?.frozen) return json(rpcResult(message.id, { content: [{ type: 'text', text: FROZEN_TEXT }], isError: true }));

  try {
    await db.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .bind(rowKey, auth.user.id, name, hash, Date.now(), Date.now()).run();
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed')) throw error;
    // A concurrent call with the same key claimed it first.
    const raced = await db.prepare('SELECT status, response FROM mcp_call WHERE idempotency_key = ?').bind(rowKey).first<{ status: string; response: string | null }>();
    if (!raced) throw error;
    if (raced.status === 'done') return replay(raced as { response: string });
    return json(rpcResult(message.id, unknownOutcome()));
  }

  // Claimed. Charge the request fee first: the journal row is already 'pending', and the bank's
  // own idempotency key (derived from ours) makes a retry of THIS charge a no-op instead of a
  // second debit. If the charge throws, the row stays 'pending' - unknown, never re-run.
  const chargeResult = await charge(env, auth.user, MCP_REQUEST_FEE_CENTS, MCP_REQUEST_FEE_DESCRIPTION, feeKey(auth.user.id, key));

  let result: Json;
  try {
    const { text, data } = await runGitTool(env, auth.user, name, args, key);
    result = {
      content: [{ type: 'text', text }],
      isError: false,
      structuredContent: {
        ...data,
        receipt: {
          requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
          balanceAfter: chargeResult.balance,
          duplicate: false,
        },
      },
    };
  } catch (error) {
    console.error(`mcp tools/call ${name} failed after charging`, error);
    // The request fee was charged; the action's own outcome is unknown. The result is terminal
    // (journaled 'done'): the call is never re-run.
    result = {
      content: [{ type: 'text', text: `The ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged, then the action failed (${String((error as Error).message || error)}). Southbag does not re-run it. Kevin has been notified.` }],
      isError: true,
      structuredContent: {
        receipt: {
          requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
          actionFailed: true,
          duplicate: false,
        },
      },
    };
  }
  await db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = ?")
    .bind(JSON.stringify(result), Date.now(), rowKey).run();
  return json(rpcResult(message.id, result));
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET' || request.method === 'DELETE')
    return json({ error: 'This endpoint speaks JSON only; no event stream.' }, 405, { allow: 'POST' });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });

  const version = request.headers.get('mcp-protocol-version');
  if (version && !SUPPORTED_VERSIONS.has(version))
    return json(rpcError(null, -32600, `Unsupported MCP protocol version '${version}'. This server speaks ${[...SUPPORTED_VERSIONS].join(', ')}.`), 400);

  let message: { id?: unknown; jsonrpc?: string; method?: string; params?: { name?: unknown; arguments?: unknown } };
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(message) || !message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return json(rpcError((message as Json)?.id ?? null, -32600, 'Invalid request: one JSON-RPC message per POST; batching is not supported.'), 400);

  // Notifications have no id and get no response body.
  if (message.id === undefined || message.id === null) {
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    return json(rpcError(null, -32600, 'Requests must carry an id; notifications use the notifications/* methods.'), 400);
  }

  switch (message.method) {
    case 'initialize':
      return json(rpcResult(message.id, initializeResult()), 200, { 'mcp-protocol-version': PROTOCOL_VERSION });
    case 'ping':
      return json(rpcResult(message.id, {}));
    case 'tools/list': {
      // Discovery is free but authenticated: the catalogue is for customers' agents.
      const auth = await resolveAgent(env, request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '');
      if ('status' in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
      return json(rpcResult(message.id, { tools: toolList(auth.scopes) }));
    }
    case 'tools/call':
      return await handleToolsCall(request, env, message as { id: unknown; params?: { name?: unknown; arguments?: unknown } });
    default:
      return json(rpcError(message.id, -32601, `Method not found: ${message.method}`));
  }
}
