// Refs live in the D1 table `refs`. refs/heads/floor-3 is virtual: listed by listRefs on every
// repository, never stored, never shown by listVisibleBranches.

import type { Env, Repo } from '../env';
import { FLOOR3_BRANCH, FLOOR3_REF, getFloor3, isFloor3Ref } from './floor3';
import { isOid } from './objects';
import { ObjectStore } from './store';

export interface Ref {
  name: string;
  oid: string;
}

export interface Branch {
  /** Short name, e.g. `main`. */
  name: string;
  /** Full ref, e.g. `refs/heads/main`. */
  ref: string;
  oid: string;
}

/** Refs stored for a repository (never includes floor-3), sorted by name. */
export async function listStoredRefs(env: Env, repoId: string): Promise<Ref[]> {
  const r = await env.DB.prepare('SELECT name, oid FROM refs WHERE repo_id = ? ORDER BY name')
    .bind(repoId)
    .all<Ref>();
  return (r.results ?? []).filter((x) => x.name !== FLOOR3_REF);
}

/** All refs of a repository as git sees them: the stored refs plus refs/heads/floor-3. */
export async function listRefs(env: Env, repo: Pick<Repo, 'id'>): Promise<Ref[]> {
  const refs = await listStoredRefs(env, repo.id);
  refs.push({ name: FLOOR3_REF, oid: (await getFloor3()).commit });
  return refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Branches for the UI: default branch first, then by name. floor-3 is never included. */
export async function listVisibleBranches(env: Env, repo: Pick<Repo, 'id' | 'default_branch'>): Promise<Branch[]> {
  const refs = await listStoredRefs(env, repo.id);
  return refs
    .filter((r) => r.name.startsWith('refs/heads/'))
    .map((r) => ({ name: r.name.slice('refs/heads/'.length), ref: r.name, oid: r.oid }))
    .sort((a, b) => (a.name === repo.default_branch ? -1 : b.name === repo.default_branch ? 1 : a.name < b.name ? -1 : 1));
}

/** Tags for the UI (refs/tags/*), by name. */
export async function listTags(env: Env, repo: Pick<Repo, 'id'>): Promise<Branch[]> {
  const refs = await listStoredRefs(env, repo.id);
  return refs
    .filter((r) => r.name.startsWith('refs/tags/'))
    .map((r) => ({ name: r.name.slice('refs/tags/'.length), ref: r.name, oid: r.oid }));
}

export async function getRef(env: Env, repoId: string, name: string): Promise<string | null> {
  if (name === FLOOR3_REF) return (await getFloor3()).commit;
  const row = await env.DB.prepare('SELECT oid FROM refs WHERE repo_id = ? AND name = ?')
    .bind(repoId, name)
    .first<{ oid: string }>();
  return row?.oid ?? null;
}

/** Create, move (oid) or delete (null) a ref. Refuses refs/heads/floor-3. */
export async function setRef(env: Env, repoId: string, name: string, oid: string | null): Promise<void> {
  if (isFloor3Ref(name)) throw new Error('branch does not exist');
  if (!name.startsWith('refs/')) throw new Error(`not a full ref name: ${name}`);
  if (oid === null || /^0{40}$/.test(oid)) {
    await env.DB.prepare('DELETE FROM refs WHERE repo_id = ? AND name = ?').bind(repoId, name).run();
    return;
  }
  if (!isOid(oid)) throw new Error(`bad object id: ${oid}`);
  await env.DB.prepare(
    `INSERT INTO refs (repo_id, name, oid, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id, name) DO UPDATE SET oid = excluded.oid, updated_at = excluded.updated_at`,
  )
    .bind(repoId, name, oid, Date.now())
    .run();
}

/**
 * Resolve a branch name, tag name, full ref, `HEAD`, full object id or abbreviated id (7+ hex)
 * to an object id. Annotated tags are peeled to what they point at. Resolves `floor-3` too.
 */
export async function resolveRef(
  env: Env,
  repo: Pick<Repo, 'id' | 'network_id' | 'default_branch'>,
  nameOrOid: string,
  store: ObjectStore = new ObjectStore(env, repo.network_id),
): Promise<string | null> {
  let name = nameOrOid.trim();
  if (!name) return null;
  if (name === 'HEAD') name = repo.default_branch;
  if (name === FLOOR3_BRANCH || name === FLOOR3_REF) return (await getFloor3()).commit;
  const candidates = name.startsWith('refs/') ? [name] : [`refs/heads/${name}`, `refs/tags/${name}`, `refs/${name}`];
  for (const ref of candidates) {
    const oid = await getRef(env, repo.id, ref);
    if (oid) return store.peel(oid);
  }
  const lower = name.toLowerCase();
  if (isOid(lower)) return (await store.has([lower])).has(lower) ? store.peel(lower) : null;
  if (/^[0-9a-f]{7,39}$/.test(lower)) {
    const floor3 = await getFloor3();
    for (const oid of floor3.objects.keys()) if (oid.startsWith(lower)) return oid;
    const rows = await env.DB.prepare('SELECT oid FROM objects WHERE network_id = ? AND oid >= ? AND oid < ? LIMIT 2')
      .bind(repo.network_id, lower, lower + 'g')
      .all<{ oid: string }>();
    if (rows.results?.length === 1) return store.peel(rows.results[0].oid);
  }
  return null;
}
