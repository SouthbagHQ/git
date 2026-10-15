// Pull, push, fork, star and unstar requests.
//
// Lifecycle: filed (filing fee, requester) -> approved by the repository owner (approval fee, charged
// to whoever approved it) or declined (declined request fee, requester) -> executed (execution fee).
// Pull and push requests are executed by git itself (src/lib/policy.ts) and are good for one use
// within 24 hours of approval. Fork, star and unstar requests are executed from the website with
// an "Execute" button once approved.

import type { Env, Repo, User } from '../env';
import { chargeFee, feeFor, money, type RequestKind } from './fees';
import { recordWebActivity } from './fraud';
import { fail } from './http';
import { newId } from './ids';
import { notify } from './notify';
import { insertRepo, repoById, repoUrl } from './repos';

export type SimpleKind = Exclude<RequestKind, 'merge'>;
export const KINDS: SimpleKind[] = ['pull', 'push', 'fork', 'star', 'unstar'];

export const KIND_LABEL: Record<SimpleKind, string> = {
  pull: 'Pull request',
  push: 'Push request',
  fork: 'Fork request',
  star: 'Star request',
  unstar: 'Unstar request',
};

/** Approved pull and push requests must be used within this long. */
export const APPROVAL_VALID_MS = 24 * 3600000;
/** Open requests nobody decides on expire after this long. */
export const OPEN_VALID_MS = 30 * 86400000;

export interface RequestRow {
  id: string;
  repo_id: string;
  kind: SimpleKind;
  requester_id: string;
  requester: string;
  reason: string;
  status: 'open' | 'approved' | 'declined' | 'executed' | 'withdrawn' | 'expired';
  decided_by: string | null;
  decider: string | null;
  decided_at: number | null;
  executed_at: number | null;
  result: string | null;
  expires_at: number | null;
  created_at: number;
}

export const requestSelect = `SELECT requests.*, r.username AS requester, d.username AS decider FROM requests
  JOIN users r ON r.id = requests.requester_id LEFT JOIN users d ON d.id = requests.decided_by`;

export const getRequest = (env: Env, id: string) =>
  env.DB.prepare(`${requestSelect} WHERE requests.id = ?`).bind(id).first<RequestRow>();

const isStarred = async (env: Env, userId: string, repoId: string) =>
  Boolean(await env.DB.prepare('SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?').bind(userId, repoId).first());

export async function fileRequest(env: Env, user: User, repo: Repo, kind: SimpleKind, reason: string): Promise<RequestRow> {
  if (!KINDS.includes(kind)) fail(404, 'Unknown request type.');
  const open = await env.DB.prepare(`SELECT 1 FROM requests WHERE repo_id = ? AND requester_id = ? AND kind = ? AND status = 'open'`)
    .bind(repo.id, user.id, kind).first();
  if (open) fail(409, `You already have an open ${KIND_LABEL[kind].toLowerCase()} for this repository.`);
  if (kind === 'star' && await isStarred(env, user.id, repo.id)) fail(409, 'You have already starred this repository. File an unstar request instead.');
  if (kind === 'unstar' && !await isStarred(env, user.id, repo.id)) fail(409, 'You have not starred this repository. File a star request first.');

  const id = newId();
  await env.DB.prepare(`INSERT INTO requests (id, repo_id, kind, requester_id, reason, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
    .bind(id, repo.id, kind, user.id, reason, Date.now() + OPEN_VALID_MS, Date.now()).run();
  await chargeFee(env, user, `${kind}_file`, `${repo.owner}/${repo.name}`);
  await notify(env, repo.owner_id, `${user.username} filed a ${KIND_LABEL[kind].toLowerCase()} on ${repo.owner}/${repo.name}.`,
    `${repoUrl(repo)}/requests/${kind}`);
  if (kind === 'star' || kind === 'unstar') await recordWebActivity(env, user, repo, kind);
  return (await getRequest(env, id))!;
}

/** Approve or decline. Only the repository owner may decide. */
export async function decideRequest(env: Env, user: User, repo: Repo, request: RequestRow, decision: 'approve' | 'decline'): Promise<string> {
  if (user.id !== repo.owner_id) fail(403, 'Only the repository owner can decide requests.');
  if (request.status !== 'open') fail(409, 'This request has already been decided.');
  const now = Date.now();
  const label = KIND_LABEL[request.kind];
  if (decision === 'approve') {
    const expires = request.kind === 'pull' || request.kind === 'push' ? now + APPROVAL_VALID_MS : null;
    await env.DB.prepare(`UPDATE requests SET status = 'approved', decided_by = ?, decided_at = ?, expires_at = ? WHERE id = ? AND status = 'open'`)
      .bind(user.id, now, expires, request.id).run();
    const fee = await chargeFee(env, user, `${request.kind}_approve`, `${repo.owner}/${repo.name}`);
    const next = request.kind === 'pull' ? 'You can now run git pull, fetch or clone once within 24 hours.'
      : request.kind === 'push' ? 'You can now run git push once within 24 hours.'
      : 'Open the request to execute it.';
    await notify(env, request.requester_id, `Your ${label.toLowerCase()} on ${repo.owner}/${repo.name} was approved. ${next}`,
      `${repoUrl(repo)}/requests/${request.kind}/${request.id}`);
    return `${label} approved. Approval fee charged to you: ${money(fee.amount)}.`;
  }
  await env.DB.prepare(`UPDATE requests SET status = 'declined', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .bind(user.id, now, request.id).run();
  const requester = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(request.requester_id).first<User>();
  if (requester) await chargeFee(env, requester, 'request_decline', `${repo.owner}/${repo.name}`);
  await notify(env, request.requester_id, `Your ${label.toLowerCase()} on ${repo.owner}/${repo.name} was declined.`,
    `${repoUrl(repo)}/requests/${request.kind}/${request.id}`);
  return `${label} declined.`;
}

export async function withdrawRequest(env: Env, user: User, request: RequestRow): Promise<string> {
  if (user.id !== request.requester_id) fail(403, 'Only the person who filed this request can withdraw it.');
  if (request.status !== 'open' && request.status !== 'approved') fail(409, 'This request can no longer be withdrawn.');
  await env.DB.prepare(`UPDATE requests SET status = 'withdrawn' WHERE id = ?`).bind(request.id).run();
  await chargeFee(env, user, 'request_withdraw');
  return 'Request withdrawn.';
}

/** Executes an approved fork, star or unstar request. Returns a message and where to go next. */
export async function executeRequest(env: Env, user: User, repo: Repo, request: RequestRow): Promise<{ message: string; to: string }> {
  if (user.id !== request.requester_id) fail(403, 'Only the person who filed this request can execute it.');
  if (request.status !== 'approved') fail(409, request.status === 'open' ? 'This request has not been approved yet.' : 'This request cannot be executed.');
  if (request.kind === 'pull' || request.kind === 'push')
    fail(409, `Approved ${request.kind} requests are executed by running git ${request.kind}.`);

  // Claim it first so nothing runs (or is charged) twice.
  const claimed = await env.DB.prepare(`UPDATE requests SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'approved'`)
    .bind(Date.now(), request.id).run();
  if (!claimed.meta.changes) fail(409, 'This request cannot be executed.');
  const fee = feeFor(request.kind, 'execute');
  await chargeFee(env, user, `${request.kind}_execute`, `${repo.owner}/${repo.name}`);

  if (request.kind === 'star') {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO stars (user_id, repo_id, created_at) VALUES (?, ?, ?)').bind(user.id, repo.id, Date.now()),
      env.DB.prepare('UPDATE repos SET stars = (SELECT COUNT(*) FROM stars WHERE repo_id = ?) WHERE id = ?').bind(repo.id, repo.id),
    ]);
    await recordWebActivity(env, user, repo, 'star_executed');
    return { message: `Starred. Execution fee: ${money(fee.amount)}.`, to: repoUrl(repo) };
  }
  if (request.kind === 'unstar') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM stars WHERE user_id = ? AND repo_id = ?').bind(user.id, repo.id),
      env.DB.prepare('UPDATE repos SET stars = (SELECT COUNT(*) FROM stars WHERE repo_id = ?) WHERE id = ?').bind(repo.id, repo.id),
    ]);
    await recordWebActivity(env, user, repo, 'unstar_executed');
    return { message: `Star removed. Star removal fee: ${money(fee.amount)}.`, to: repoUrl(repo) };
  }

  // Fork: same object store (network), copied refs, a fresh The Issue.
  let name = repo.name;
  for (let n = 1; await env.DB.prepare('SELECT 1 FROM repos WHERE owner_id = ? AND name = ?').bind(user.id, name).first(); n++)
    name = `${repo.name}-fork${n > 1 ? '-' + n : ''}`;
  const fork = await insertRepo(env, user, {
    name, description: repo.description, defaultBranch: repo.default_branch, networkId: repo.network_id, forkedFrom: repo.id,
  });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO refs (repo_id, name, oid, updated_at) SELECT ?, name, oid, ? FROM refs WHERE repo_id = ?')
      .bind(fork.id, Date.now(), repo.id),
    env.DB.prepare('UPDATE repos SET forks = forks + 1 WHERE id = ?').bind(repo.id),
    env.DB.prepare('UPDATE requests SET result = ? WHERE id = ?').bind(fork.id, request.id),
  ]);
  await notify(env, repo.owner_id, `${user.username} forked ${repo.owner}/${repo.name}.`, repoUrl(fork));
  return { message: `Forked to ${fork.owner}/${fork.name}. Execution fee: ${money(fee.amount)}.`, to: repoUrl(fork) };
}

/**
 * For git: takes the user's oldest approved, unexpired pull or push request on the repo and marks it
 * executed. Returns the request id, or null if there isn't one.
 */
export async function consumeApproved(env: Env, user: User, repo: Repo, kind: 'pull' | 'push'): Promise<string | null> {
  const row = await env.DB.prepare(`UPDATE requests SET status = 'executed', executed_at = ?
    WHERE id = (SELECT id FROM requests WHERE repo_id = ? AND requester_id = ? AND kind = ? AND status = 'approved'
      AND (expires_at IS NULL OR expires_at > ?) ORDER BY decided_at LIMIT 1)
    RETURNING id`).bind(Date.now(), repo.id, user.id, kind, Date.now()).first<{ id: string }>();
  return row?.id ?? null;
}

/** Whether the user holds an approved, unexpired pull or push request on the repo (without using it). */
export async function hasApproved(env: Env, user: User, repo: Repo, kind: 'pull' | 'push'): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM requests WHERE repo_id = ? AND requester_id = ? AND kind = ? AND status = 'approved'
    AND (expires_at IS NULL OR expires_at > ?)`).bind(repo.id, user.id, kind, Date.now()).first());
}

export { repoById };
