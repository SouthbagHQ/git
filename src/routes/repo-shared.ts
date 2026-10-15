// Shared helpers for /:owner/:repo pages.

import type { Ctx, Repo } from '../env';
import { fail } from '../lib/http';
import { getRepo } from '../lib/repos';
import { repoHeader } from '../views/layout';

export async function loadRepo(c: Ctx): Promise<Repo> {
  const repo = await getRepo(c.env, c.req.param('owner') ?? '', c.req.param('repo') ?? '');
  if (!repo) fail(404, 'Repository not found.');
  return repo;
}

export type Tab = Parameters<typeof repoHeader>[1]['active'];

/** The repo header with counts for every tab. */
export async function header(c: Ctx, repo: Repo, active: Tab) {
  const user = c.get('user');
  const counts = await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM issues WHERE repo_id = ?1 AND state = 'open') AS issues,
      (SELECT COUNT(*) FROM merge_requests WHERE repo_id = ?1 AND status IN ('open', 'approved')) AS merge,
      (SELECT COUNT(*) FROM requests WHERE repo_id = ?1 AND status = 'open') AS requests,
      (SELECT COUNT(*) FROM pushes WHERE repo_id = ?1 AND status = 'pending') AS pushes`)
    .bind(repo.id).first<Record<string, number>>();
  const starred = user ? Boolean(await c.env.DB.prepare('SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?').bind(user.id, repo.id).first()) : false;
  const parent = repo.forked_from ? await c.env.DB.prepare(`SELECT users.username AS owner, repos.name FROM repos JOIN users ON users.id = repos.owner_id WHERE repos.id = ?`)
    .bind(repo.forked_from).first<{ owner: string; name: string }>() : null;
  return repoHeader(repo, { user, active, counts: counts ?? {}, starred, parent });
}

import type { FileDiff } from '../git/diff';
import type { Person } from '../git/objects';
import type { DiffFile } from '../views/code';

/** Engine diffs (src/git/diff.ts) to the shape the diff view (src/views/code.ts) renders. */
export const toDiffFiles = (files: FileDiff[]): DiffFile[] => files.map(f => ({
  path: f.path,
  change: f.status,
  binary: f.binary,
  note: f.truncated ? 'This diff is too large to show in full.' : null,
  hunks: f.hunks.map(h => ({
    header: h.header,
    lines: h.lines.map(l => ({ kind: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', text: l.text, oldNo: l.oldNo, newNo: l.newNo })),
  })),
}));

/** A git identity stamped now, in AEST. */
export const person = (name: string, email: string): Person => ({ name, email, time: Math.floor(Date.now() / 1000), tz: '+1000' });

export const KEVIN = () => person('Kevin', 'Kevin@southbag.cc');
