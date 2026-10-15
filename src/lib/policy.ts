// The rules git over HTTPS has to get past. The transport (src/routes/git.ts, src/git/*) calls these
// and never decides anything about money, requests, fraud or business hours itself.
//
import type { Env, Repo, User } from '../env';
import { chargeFee, FEES, money } from './fees';
import { hasApproved, consumeApproved } from './requests';
import { reviewPush as review } from './pushes';
import { userFromBasicAuth } from './tokens';

const site = 'https://git.southbag.cc';
const frozen = { ok: false, message: `Your account is frozen pending review. Answer the security questions at ${site}/security` } as const;

export type Waiter = { waitUntil(promise: Promise<unknown>): void };

/** One ref update from a push, as sent by the client. Zero oid = create (old) or delete (new). */
export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

/** A commit introduced by a push (reachable from `new`, not from any existing ref). */
export interface PushedCommit {
  oid: string;
  message: string;
  author: { name: string; email: string; time: number; tz: string };   // time: unix seconds
  committer: { name: string; email: string; time: number; tz: string };
  parents: string[];
}

/** What the transport works out about each ref update before asking for a verdict. */
export interface PushAnalysis {
  update: RefUpdate;
  /** Commits new to the repository on this ref, newest first (capped at 500). */
  commits: PushedCommit[];
  /** True if `old` is not an ancestor of `new` (a force push). False for creates and deletes. */
  forced: boolean;
  deleted: boolean;
  created: boolean;
  /** Tree diff between old and new tips (zero for creates/deletes). */
  filesAdded: number;
  filesDeleted: number;
  filesModified: number;
  linesAdded: number;
  linesDeleted: number;
}

export type Verdict = { ok: true } | { ok: false; message: string };

/** Basic auth on git requests: username (or anything) + personal access token as the password. */
export async function gitAuthenticate(env: Env, request: Request): Promise<User | null> {
  return userFromBasicAuth(env, request);
}

const hasCloned = async (env: Env, user: User, repo: Repo) =>
  Boolean(await env.DB.prepare('SELECT 1 FROM clones WHERE user_id = ? AND repo_id = ?').bind(user.id, repo.id).first());

const needPullRequest = (user: User, repo: Repo): Verdict => ({
  ok: false,
  message: `You need an approved pull request to pull from ${repo.owner}/${repo.name}. File one at ${site}/requests (signed in as ${user.username})`,
});

/**
 * Called on the upload-pack ref advertisement (every clone, fetch and pull starts here, including
 * pulls that turn out to be up to date and never ask for a pack). Someone who has already cloned
 * the repository needs an approved pull request: it is used up and the execution fee charged here.
 * Someone who hasn't is let through to clone.
 */
export async function beforeListRefs(env: Env, user: User, repo: Repo): Promise<Verdict> {
  if (user.frozen) return frozen;
  if (!await hasCloned(env, user, repo)) return { ok: true };
  if (!await consumeApproved(env, user, repo, 'pull')) return needPullRequest(user, repo);
  await chargeFee(env, user, 'pull_execute', `${repo.owner}/${repo.name}`);
  return { ok: true };
}

/**
 * Called before upload-pack sends a pack. The first pack anyone fetches from a repository is their
 * clone: no request, only the clone fee. After that, the pack must follow a pull request used on the
 * ref advertisement in the last ten minutes. The message is shown by git as `fatal: remote error: …`.
 */
export async function beforeFetch(env: Env, _ctx: Waiter, user: User, repo: Repo): Promise<Verdict> {
  if (user.frozen) return frozen;
  if (!await hasCloned(env, user, repo)) {
    await env.DB.prepare('INSERT OR IGNORE INTO clones (user_id, repo_id, created_at) VALUES (?, ?, ?)').bind(user.id, repo.id, Date.now()).run();
    await chargeFee(env, user, 'clone', `${repo.owner}/${repo.name}`);
    return { ok: true };
  }
  const used = await env.DB.prepare(`SELECT 1 FROM requests WHERE repo_id = ? AND requester_id = ? AND kind = 'pull'
    AND status = 'executed' AND executed_at > ?`).bind(repo.id, user.id, Date.now() - 10 * 60000).first();
  return used ? { ok: true } : needPullRequest(user, repo);
}

/** Line shown after a successful fetch. */
export const fetchNote = `Pull request used. ${FEES.pull_execute.label}: ${money(FEES.pull_execute.amount)}.`;

/** Called on the receive-pack ref advertisement and before reading a pushed pack. Needs an approved push request. */
export async function beforePush(env: Env, user: User, repo: Repo): Promise<Verdict> {
  if (user.frozen) return frozen;
  if (!await hasApproved(env, user, repo, 'push'))
    return { ok: false, message: `You need an approved push request to push to ${repo.owner}/${repo.name}. File one at ${site}/requests (signed in as ${user.username})` };
  return { ok: true };
}

/**
 * Called after the pushed objects have been stored. Decides each ref update, records the push as
 * pending (refs move later, in business hours — see src/lib/pushes.ts) and returns, per ref,
 * null for "ok" or the reason for "ng", plus lines to print as `remote: …`.
 * The transport must NOT move refs itself.
 */
export async function reviewPush(env: Env, ctx: Waiter, user: User, repo: Repo, analyses: PushAnalysis[]):
  Promise<{ results: Record<string, string | null>; messages: string[] }> {
  return review(env, ctx, user, repo, analyses);
}
