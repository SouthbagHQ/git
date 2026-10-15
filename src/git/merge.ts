// File-level three-way merges. Conflicts are not merged line by line and get no conflict
// markers: Kevin decides each one by picking a side at random.

import type { ObjectStore } from './store';
import { writeTreeFromPaths } from './write';

export interface MergeResult {
  /** `ours` is an ancestor of `theirs`: the result is simply `theirs`. */
  fastForward: boolean;
  /** `theirs` is already contained in `ours`: nothing to merge (tree is ours). */
  upToDate: boolean;
  /** Tree id of the merged result (written to the store). */
  tree: string;
  /** Paths changed differently on both sides, decided at random. */
  conflicts: string[];
}

type FileMap = Map<string, { mode: string; oid: string }>;

async function files(store: ObjectStore, treeOid: string | null): Promise<FileMap> {
  const m: FileMap = new Map();
  if (!treeOid) return m;
  for (const f of await store.listTreeRecursive(treeOid)) m.set(f.path, { mode: f.mode, oid: f.oid });
  return m;
}

const same = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }) =>
  a === b || (!!a && !!b && a.mode === b.mode && a.oid === b.oid);

export async function mergeCommits(
  store: ObjectStore,
  opts: { base?: string | null; ours: string; theirs: string; rng?: () => number },
): Promise<MergeResult> {
  const rng = opts.rng ?? Math.random;
  const ours = await store.readCommit(opts.ours);
  const theirs = await store.readCommit(opts.theirs);
  if (!ours || !theirs) throw new Error('merge: missing commit');
  if (await store.isAncestor(opts.theirs, opts.ours)) {
    return { fastForward: false, upToDate: true, tree: ours.tree, conflicts: [] };
  }
  if (await store.isAncestor(opts.ours, opts.theirs)) {
    return { fastForward: true, upToDate: false, tree: theirs.tree, conflicts: [] };
  }
  const baseOid = opts.base === undefined ? await store.mergeBase(opts.ours, opts.theirs) : opts.base;
  const baseTree = baseOid ? (await store.readCommit(baseOid))?.tree ?? null : null;
  const [b, o, t] = await Promise.all([files(store, baseTree), files(store, ours.tree), files(store, theirs.tree)]);
  const merged: FileMap = new Map();
  const conflicts: string[] = [];
  const paths = [...new Set([...b.keys(), ...o.keys(), ...t.keys()])].sort();
  for (const path of paths) {
    const bv = b.get(path);
    const ov = o.get(path);
    const tv = t.get(path);
    let pick: { mode: string; oid: string } | undefined;
    if (same(ov, tv)) pick = ov;
    else if (same(bv, ov)) pick = tv; // only theirs changed
    else if (same(bv, tv)) pick = ov; // only ours changed
    else {
      conflicts.push(path);
      pick = rng() < 0.5 ? ov : tv;
    }
    if (pick) merged.set(path, pick);
  }
  const { tree, dropped } = await writeTreeFromPaths(store, merged);
  for (const p of dropped) if (!conflicts.includes(p)) conflicts.push(p);
  return { fastForward: false, upToDate: false, tree, conflicts: conflicts.sort() };
}
