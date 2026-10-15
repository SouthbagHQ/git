// Creating objects from the web side (new repositories, merges, README edits).

import {
  hashObject,
  serializeCommit,
  serializeTree,
  utf8,
  type Commit,
  type ObjectType,
  type Person,
  type TreeEntry,
} from './objects';
import type { ObjectStore } from './store';

export async function writeBlob(store: ObjectStore, data: string | Uint8Array): Promise<string> {
  return store.put('blob', typeof data === 'string' ? utf8(data) : data);
}

/** Write a tree from its entries (sorted into git order for you). Modes: '100644', '40000', ... */
export async function writeTree(store: ObjectStore, entries: TreeEntry[]): Promise<string> {
  return store.put('tree', serializeTree(entries));
}

export interface NewCommit {
  tree: string;
  parents: string[];
  author: Person;
  committer?: Person;
  message: string;
}

export async function writeCommit(store: ObjectStore, c: NewCommit): Promise<string> {
  const commit: Commit = {
    tree: c.tree,
    parents: c.parents,
    author: c.author,
    committer: c.committer ?? c.author,
    message: c.message.endsWith('\n') ? c.message : c.message + '\n',
  };
  return store.put('commit', serializeCommit(commit));
}

type Dir = { files: Map<string, { mode: string; data: Uint8Array }>; dirs: Map<string, Dir> };

/**
 * Write nested trees for a set of files (path → content) in one batch; returns the root tree id.
 * Paths use '/'; content is text or bytes. Mode is 100644.
 */
export async function writeFiles(store: ObjectStore, files: Record<string, string | Uint8Array>): Promise<string> {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.dirs.has(p)) dir.dirs.set(p, { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(p)!;
    }
    dir.files.set(parts[parts.length - 1], { mode: '100644', data: typeof content === 'string' ? utf8(content) : content });
  }
  const pending: { oid: string; type: ObjectType; data: Uint8Array }[] = [];
  const add = async (type: ObjectType, data: Uint8Array) => {
    const oid = await hashObject(type, data);
    pending.push({ oid, type, data });
    return oid;
  };
  const writeDir = async (dir: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of dir.files) entries.push({ mode: f.mode, name, oid: await add('blob', f.data) });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: await writeDir(sub) });
    return add('tree', serializeTree(entries));
  };
  const tree = await writeDir(root);
  await store.putMany(pending);
  return tree;
}

/** A root commit containing `files`. Returns the commit id (no ref is created). */
export async function initialCommit(
  store: ObjectStore,
  files: Record<string, string | Uint8Array>,
  author: Person,
  message = 'Initial commit',
): Promise<string> {
  const tree = await writeFiles(store, files);
  return writeCommit(store, { tree, parents: [], author, committer: author, message });
}

/**
 * Write a tree from a flat path → {mode, oid} map (blobs must already exist). Used by merges.
 * If a path is both a file and a directory, the directory wins and the path is returned in
 * `dropped`.
 */
export async function writeTreeFromPaths(
  store: ObjectStore,
  files: Map<string, { mode: string; oid: string }>,
): Promise<{ tree: string; dropped: string[] }> {
  type D = { files: Map<string, { mode: string; oid: string; path: string }>; dirs: Map<string, D> };
  const root: D = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.dirs.has(p)) dir.dirs.set(p, { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(p)!;
    }
    dir.files.set(parts[parts.length - 1], { ...f, path });
  }
  const dropped: string[] = [];
  const pending: { oid: string; type: ObjectType; data: Uint8Array }[] = [];
  const writeDir = async (dir: D): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: await writeDir(sub) });
    for (const [name, f] of dir.files) {
      if (dir.dirs.has(name)) dropped.push(f.path);
      else entries.push({ mode: f.mode, name, oid: f.oid });
    }
    const data = serializeTree(entries);
    const oid = await hashObject('tree', data);
    pending.push({ oid, type: 'tree', data });
    return oid;
  };
  const tree = await writeDir(root);
  await store.putMany(pending);
  return { tree, dropped };
}
