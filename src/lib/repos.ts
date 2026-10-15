// Repositories: lookup, creation, forking. Every repository is born with The Issue (#1).

import type { Env, Repo, User } from '../env';
import { newId } from './ids';

const repoSelect = `SELECT repos.*, users.username AS owner FROM repos JOIN users ON users.id = repos.owner_id`;

export const getRepo = (env: Env, owner: string, name: string) =>
  env.DB.prepare(`${repoSelect} WHERE users.username = ? AND repos.name = ?`).bind(owner, name.replace(/\.git$/, '')).first<Repo>();

export const repoById = (env: Env, id: string) =>
  env.DB.prepare(`${repoSelect} WHERE repos.id = ?`).bind(id).first<Repo>();

export const listRepos = async (env: Env, where: string, binds: unknown[], order = 'repos.updated_at DESC', limit = 30, offset = 0) =>
  (await env.DB.prepare(`${repoSelect} ${where ? 'WHERE ' + where : ''} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset).all<Repo>()).results;

/** The Issue: number 1 in every repository. Raised by Kevin, resolved in 2019, immutable. */
export const theIssueStatement = (env: Env, repoId: string) =>
  env.DB.prepare(`INSERT INTO issues (id, repo_id, number, author_id, title, body, state, locked, immutable, display_date, created_at, closed_at)
    VALUES (?, ?, 1, 'kevin', 'The Issue', ?, 'closed', 1, 1, '2019', 1561939200000, 1561939200000)`)
    .bind(newId(), repoId, 'The Issue is considered resolved.');

/** Inserts a repository row (and The Issue). Returns the new repo. Fees and git content are the caller's job. */
export async function insertRepo(env: Env, owner: User, input: { name: string; description: string; defaultBranch?: string; networkId?: string; forkedFrom?: string }): Promise<Repo> {
  const id = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO repos (id, owner_id, name, description, default_branch, network_id, forked_from, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, owner.id, input.name, input.description, input.defaultBranch || 'main', input.networkId || id, input.forkedFrom || null, now, now),
    theIssueStatement(env, id),
  ]);
  return (await repoById(env, id))!;
}

export const repoUrl = (repo: Pick<Repo, 'owner' | 'name'>) => `/${repo.owner}/${repo.name}`;

export const isOwner = (user: User | null, repo: Repo) => Boolean(user && user.id === repo.owner_id);
