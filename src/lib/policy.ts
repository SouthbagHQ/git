// The rules git over HTTPS has to get past. The transport (src/routes/git.ts, src/git/*) calls these
// and never decides anything about money, requests, fraud or business hours itself.
//
// STUBS: the signatures are the contract; the bodies are filled in by src/lib/requests.ts,
// src/lib/fraud.ts and src/lib/pushes.ts.

import type { Env, Repo, User } from '../env';

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
export async function gitAuthenticate(_env: Env, _request: Request): Promise<User | null> {
  return null;
}

/**
 * Called before upload-pack sends a pack (clone, fetch, pull) — not for the ref advertisement.
 * Needs an approved pull request on the repo; consumes it and charges the execution fee.
 * The message is shown by git as `remote: …` / `fatal: …`.
 */
export async function beforeFetch(_env: Env, _ctx: Waiter, _user: User, _repo: Repo): Promise<Verdict> {
  return { ok: true };
}

/** Called on the receive-pack ref advertisement and before reading a pushed pack. Needs an approved push request. */
export async function beforePush(_env: Env, _user: User, _repo: Repo): Promise<Verdict> {
  return { ok: true };
}

/**
 * Called after the pushed objects have been stored. Decides each ref update, records the push as
 * pending (refs move later, in business hours — see src/lib/pushes.ts) and returns, per ref,
 * null for "ok" or the reason for "ng", plus lines to print as `remote: …`.
 * The transport must NOT move refs itself.
 */
export async function reviewPush(_env: Env, _ctx: Waiter, _user: User, _repo: Repo, _analyses: PushAnalysis[]):
  Promise<{ results: Record<string, string | null>; messages: string[] }> {
  return { results: {}, messages: [] };
}
