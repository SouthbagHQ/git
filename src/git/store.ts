// Object storage over the D1 table `objects`, keyed by network (forks share their parent's
// network). Objects are stored uncompressed. floor-3's objects are virtual (see floor3.ts) and
// served as a fallback. One ObjectStore per request: it caches what it reads.

import type { Env } from '../env';
import { getFloor3 } from './floor3';
import {
  hashObject,
  isGitlinkMode,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  type Commit,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './objects';

/** D1 rows are limited to 2 MB. */
export const MAX_OBJECT_SIZE = 1_900_000;

const IN_CHUNK = 90; // D1 allows ~100 bound parameters per statement
const BATCH_STATEMENTS = 50;
const BATCH_BYTES = 8_000_000;
const PRELOAD_AFTER_MISSES = 64;
const PRELOAD_LIMIT = 50_000;
const MAX_WALK = 50_000;

export class ObjectTooLargeError extends Error {
  constructor(readonly oid: string, readonly size: number) {
    super(`object ${oid} is ${(size / 1e6).toFixed(1)} MB; the limit is 1.9 MB per object`);
  }
}

export interface TreeFile {
  path: string;
  mode: string;
  oid: string;
}

export type PathResult =
  | { kind: 'tree'; oid: string; entries: TreeEntry[] }
  | { kind: 'blob'; oid: string; mode: string; data: Uint8Array }
  | { kind: 'gitlink'; oid: string };

export interface LogEntry {
  oid: string;
  commit: Commit;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('unexpected blob value from D1');
}

/** Binary max-heap of commits by committer time (newest first). */
class DateQueue {
  private items: { oid: string; time: number }[] = [];
  get size() {
    return this.items.length;
  }
  oids(): string[] {
    return this.items.map((i) => i.oid);
  }
  push(oid: string, time: number) {
    const a = this.items;
    a.push({ oid, time });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].time >= a[i].time) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): string | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].time > a[m].time) m = l;
        if (r < a.length && a[r].time > a[m].time) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.oid;
  }
}

export class ObjectStore {
  private cache = new Map<string, GitObject>();
  private missing = new Set<string>();
  private commits = new Map<string, Commit>();
  private trees = new Map<string, TreeEntry[]>();
  private misses = 0;
  private preloaded = false;

  constructor(readonly env: Env, readonly networkId: string) {}

  // ---- raw access ----

  async get(oid: string): Promise<GitObject | null> {
    return (await this.getMany([oid])).get(oid) ?? null;
  }

  /**
   * Fetch several objects in one round trip. `cache: false` keeps large blobs out of the
   * per-request cache (used when streaming a pack).
   */
  async getMany(oids: string[], opts: { cache?: boolean } = {}): Promise<Map<string, GitObject>> {
    const out = new Map<string, GitObject>();
    const need: string[] = [];
    const floor3 = await getFloor3();
    for (const oid of new Set(oids)) {
      const hit = this.cache.get(oid) ?? floor3.objects.get(oid);
      if (hit) out.set(oid, hit);
      else if (!this.missing.has(oid)) need.push(oid);
    }
    if (!need.length) return out;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < need.length; i += IN_CHUNK) {
      const chunk = need.slice(i, i + IN_CHUNK);
      stmts.push(
        this.env.DB.prepare(
          `SELECT oid, type, data FROM objects WHERE network_id = ? AND oid IN (${chunk.map(() => '?').join(',')})`,
        ).bind(this.networkId, ...chunk),
      );
    }
    for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) {
      const results = await this.env.DB.batch<{ oid: string; type: ObjectType; data: unknown }>(
        stmts.slice(i, i + BATCH_STATEMENTS),
      );
      for (const r of results) {
        for (const row of r.results ?? []) {
          const obj = { type: row.type, data: toBytes(row.data) };
          out.set(row.oid, obj);
          if (opts.cache !== false || obj.type !== 'blob') this.cache.set(row.oid, obj);
        }
      }
    }
    for (const oid of need) if (!out.has(oid)) this.missing.add(oid);
    return out;
  }

  /** Which of these objects exist (in the network or in floor-3). */
  async has(oids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const need: string[] = [];
    const floor3 = await getFloor3();
    for (const oid of new Set(oids)) {
      if (this.cache.has(oid) || floor3.objects.has(oid)) found.add(oid);
      else need.push(oid);
    }
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < need.length; i += IN_CHUNK) {
      const chunk = need.slice(i, i + IN_CHUNK);
      stmts.push(
        this.env.DB.prepare(
          `SELECT oid FROM objects WHERE network_id = ? AND oid IN (${chunk.map(() => '?').join(',')})`,
        ).bind(this.networkId, ...chunk),
      );
    }
    for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) {
      const results = await this.env.DB.batch<{ oid: string }>(stmts.slice(i, i + BATCH_STATEMENTS));
      for (const r of results) for (const row of r.results ?? []) found.add(row.oid);
    }
    return found;
  }

  /** Store one object; returns its id. */
  async put(type: ObjectType, data: Uint8Array): Promise<string> {
    const [oid] = await this.putMany([{ type, data }]);
    return oid;
  }

  /**
   * Store objects (ids computed when not given). Existing objects are skipped.
   * Throws ObjectTooLargeError for objects over 1.9 MB before writing anything.
   */
  async putMany(objects: { oid?: string; type: ObjectType; data: Uint8Array }[]): Promise<string[]> {
    const withIds: { oid: string; type: ObjectType; data: Uint8Array }[] = [];
    for (const o of objects) withIds.push({ ...o, oid: o.oid ?? (await hashObject(o.type, o.data)) });
    for (const o of withIds) if (o.data.length > MAX_OBJECT_SIZE) throw new ObjectTooLargeError(o.oid, o.data.length);
    const floor3 = await getFloor3();
    const candidates = withIds.filter((o) => !floor3.objects.has(o.oid));
    const existing = await this.has(candidates.map((o) => o.oid));
    const seen = new Set<string>();
    const todo = candidates.filter((o) => !existing.has(o.oid) && !seen.has(o.oid) && seen.add(o.oid));
    let batch: D1PreparedStatement[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length) await this.env.DB.batch(batch);
      batch = [];
      bytes = 0;
    };
    for (const o of todo) {
      batch.push(
        this.env.DB.prepare(
          'INSERT OR IGNORE INTO objects (network_id, oid, type, size, data) VALUES (?, ?, ?, ?, ?)',
        ).bind(this.networkId, o.oid, o.type, o.data.length, o.data),
      );
      bytes += o.data.length + 200;
      if (batch.length >= BATCH_STATEMENTS || bytes >= BATCH_BYTES) await flush();
    }
    await flush();
    for (const o of withIds) {
      this.missing.delete(o.oid);
      if (o.type !== 'blob' || o.data.length < 65536) this.cache.set(o.oid, { type: o.type, data: o.data });
    }
    return withIds.map((o) => o.oid);
  }

  /** Put already-parsed objects in the cache without writing them (e.g. objects from a pack). */
  remember(oid: string, obj: GitObject): void {
    this.cache.set(oid, obj);
    this.missing.delete(oid);
  }

  /**
   * Load every commit of the network into the cache in one query. Graph walks call this
   * automatically after a few dozen cache misses, so long histories cost one round trip.
   */
  async preloadCommits(): Promise<void> {
    if (this.preloaded) return;
    this.preloaded = true;
    const r = await this.env.DB.prepare(
      `SELECT oid, data FROM objects WHERE network_id = ? AND type = 'commit' LIMIT ${PRELOAD_LIMIT}`,
    )
      .bind(this.networkId)
      .all<{ oid: string; data: unknown }>();
    for (const row of r.results ?? []) {
      if (!this.cache.has(row.oid)) this.cache.set(row.oid, { type: 'commit', data: toBytes(row.data) });
    }
  }

  // ---- typed reads ----

  async readCommit(oid: string): Promise<Commit | null> {
    const hit = this.commits.get(oid);
    if (hit) return hit;
    if (!this.cache.has(oid)) {
      if (++this.misses > PRELOAD_AFTER_MISSES) await this.preloadCommits();
    }
    const obj = await this.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const c = parseCommit(obj.data);
    this.commits.set(oid, c);
    return c;
  }

  /** Load several commits at once (prefetch for walks). */
  async readCommits(oids: string[]): Promise<void> {
    const need = oids.filter((o) => !this.commits.has(o) && !this.cache.has(o));
    if (need.length > 1) await this.getMany(need);
  }

  async readTree(oid: string): Promise<TreeEntry[] | null> {
    const hit = this.trees.get(oid);
    if (hit) return hit;
    const obj = await this.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const t = parseTree(obj.data);
    this.trees.set(oid, t);
    return t;
  }

  async readBlob(oid: string): Promise<Uint8Array | null> {
    const obj = await this.get(oid);
    return obj && obj.type === 'blob' ? obj.data : null;
  }

  /** Follow annotated tags to the object they point at; returns a commit/tree/blob id or null. */
  async peel(oid: string): Promise<string | null> {
    for (let i = 0; i < 10; i++) {
      const obj = await this.get(oid);
      if (!obj) return null;
      if (obj.type !== 'tag') return oid;
      oid = parseTag(obj.data).object;
    }
    return null;
  }

  /** The root tree of a commit (or a tree id given directly). */
  async treeOf(oid: string): Promise<string | null> {
    const peeled = await this.peel(oid);
    if (!peeled) return null;
    const obj = await this.get(peeled);
    if (obj?.type === 'tree') return peeled;
    if (obj?.type === 'commit') return (await this.readCommit(peeled))!.tree;
    return null;
  }

  /** Every file (blob or gitlink) under a tree, with full paths. Loads one tree level per round trip. */
  async listTreeRecursive(treeOid: string): Promise<TreeFile[]> {
    const files: TreeFile[] = [];
    let level: { oid: string; prefix: string }[] = [{ oid: treeOid, prefix: '' }];
    while (level.length) {
      await this.getMany(level.map((l) => l.oid).filter((o) => !this.trees.has(o)));
      const next: { oid: string; prefix: string }[] = [];
      for (const { oid, prefix } of level) {
        const entries = await this.readTree(oid);
        if (!entries) throw new Error(`missing tree ${oid}`);
        for (const e of entries) {
          const path = prefix + e.name;
          if (isTreeMode(e.mode)) next.push({ oid: e.oid, prefix: path + '/' });
          else files.push({ path, mode: e.mode, oid: e.oid });
        }
      }
      level = next;
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The tree entry at `path` under a tree ('' = the tree itself). */
  async entryAt(treeOid: string, path: string): Promise<{ mode: string; oid: string } | null> {
    const parts = path.split('/').filter(Boolean);
    let cur = { mode: '40000', oid: treeOid };
    for (const part of parts) {
      if (!isTreeMode(cur.mode)) return null;
      const entries = await this.readTree(cur.oid);
      const e = entries?.find((x) => x.name === part);
      if (!e) return null;
      cur = { mode: e.mode, oid: e.oid };
    }
    return cur;
  }

  /** What is at `path` in a commit: a directory listing, a file, or a submodule. */
  async getPath(commitOid: string, path: string): Promise<PathResult | null> {
    const tree = await this.treeOf(commitOid);
    if (!tree) return null;
    const e = await this.entryAt(tree, path);
    if (!e) return null;
    if (isTreeMode(e.mode)) {
      const entries = await this.readTree(e.oid);
      return entries ? { kind: 'tree', oid: e.oid, entries } : null;
    }
    if (isGitlinkMode(e.mode)) return { kind: 'gitlink', oid: e.oid };
    const data = await this.readBlob(e.oid);
    return data ? { kind: 'blob', oid: e.oid, mode: e.mode, data } : null;
  }

  // ---- history ----

  /**
   * Commits reachable from `include` but not from `exclude`, newest first (date order, like
   * `git rev-list include --not exclude`). Missing excluded commits are ignored.
   */
  async revList(include: string[], exclude: string[], opts: { limit?: number } = {}): Promise<string[]> {
    const UNINTERESTING = 1;
    const SEEN = 2;
    const flags = new Map<string, number>();
    const queue = new DateQueue();
    const out: string[] = [];
    const limit = opts.limit ?? Infinity;
    const enqueue = async (oids: string[], uninteresting: boolean) => {
      await this.readCommits(oids);
      for (const oid of oids) {
        const f = flags.get(oid) ?? 0;
        if (uninteresting && !(f & UNINTERESTING)) flags.set(oid, f | UNINTERESTING);
        if (f & SEEN) continue;
        const c = await this.readCommit(oid);
        if (!c) {
          if (uninteresting) continue;
          throw new Error(`missing commit ${oid}`);
        }
        flags.set(oid, (flags.get(oid) ?? 0) | SEEN);
        queue.push(oid, c.committer.time);
      }
    };
    const excl: string[] = [];
    for (const x of exclude) {
      const p = await this.peel(x);
      if (p && (await this.get(p))?.type === 'commit') excl.push(p);
    }
    const incl: string[] = [];
    for (const x of include) {
      const p = await this.peel(x);
      if (p && (await this.get(p))?.type === 'commit') incl.push(p);
    }
    await enqueue(excl, true);
    await enqueue(incl, false);
    let visited = 0;
    while (queue.size) {
      if (queue.oids().every((o) => (flags.get(o) ?? 0) & UNINTERESTING)) break;
      if (++visited > MAX_WALK) break;
      const oid = queue.pop()!;
      const c = (await this.readCommit(oid))!;
      const unint = !!((flags.get(oid) ?? 0) & UNINTERESTING);
      if (!unint) {
        out.push(oid);
        if (out.length >= limit) break;
      }
      await enqueue(c.parents, unint);
    }
    return out;
  }

  /** True if commit `a` is an ancestor of (or equal to) commit `b`. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    if (!(await this.readCommit(a)) || !(await this.readCommit(b))) return false;
    return (await this.revList([a], [b], { limit: 1 })).length === 0;
  }

  /** The best common ancestor of two commits, or null if their histories are unrelated. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    if (a === b) return a;
    const P1 = 1;
    const P2 = 2;
    const STALE = 4;
    const flags = new Map<string, number>();
    const queue = new DateQueue();
    const add = async (oid: string, f: number) => {
      const cur = flags.get(oid) ?? 0;
      if ((cur & f) === f) return;
      const c = await this.readCommit(oid);
      if (!c) return;
      flags.set(oid, cur | f);
      queue.push(oid, c.committer.time);
    };
    await add(a, P1);
    await add(b, P2);
    let visited = 0;
    while (queue.size) {
      if (queue.oids().every((o) => (flags.get(o) ?? 0) & STALE)) break;
      if (++visited > MAX_WALK) break;
      const oid = queue.pop()!;
      let f = flags.get(oid)!;
      if ((f & (P1 | P2)) === (P1 | P2) && !(f & STALE)) return oid;
      const c = (await this.readCommit(oid))!;
      await this.readCommits(c.parents);
      for (const p of c.parents) await add(p, f & (P1 | P2 | STALE));
    }
    return null;
  }

  /** Number of commits reachable from `oid`, stopping at `cap`. */
  async countCommits(oid: string, cap = 10_000): Promise<number> {
    const seen = new Set<string>();
    let frontier = [oid];
    while (frontier.length && seen.size < cap) {
      await this.readCommits(frontier);
      const next: string[] = [];
      for (const o of frontier) {
        if (seen.has(o) || seen.size >= cap) continue;
        const c = await this.readCommit(o);
        if (!c) continue;
        seen.add(o);
        for (const p of c.parents) if (!seen.has(p)) next.push(p);
      }
      frontier = next;
    }
    return seen.size;
  }

  /**
   * History from `fromOid`, newest first. With `path`, only commits that changed that path
   * (git's default history simplification: a merge that kept one parent's version follows only
   * that parent).
   */
  async log(fromOid: string, opts: { limit?: number; skip?: number; path?: string } = {}): Promise<LogEntry[]> {
    const limit = opts.limit ?? 30;
    let skip = opts.skip ?? 0;
    const path = opts.path?.replace(/^\/+|\/+$/g, '') || '';
    const start = await this.peel(fromOid);
    if (!start) return [];
    const out: LogEntry[] = [];
    const seen = new Set<string>();
    const queue = new DateQueue();
    const first = await this.readCommit(start);
    if (!first) return [];
    queue.push(start, first.committer.time);
    seen.add(start);
    const pathOid = async (c: Commit) => (path ? (await this.entryAt(c.tree, path))?.oid ?? null : null);
    let visited = 0;
    while (queue.size && out.length < limit) {
      if (++visited > MAX_WALK) break;
      const oid = queue.pop()!;
      const c = (await this.readCommit(oid))!;
      await this.readCommits(c.parents);
      let follow = c.parents;
      let include = true;
      if (path) {
        const mine = await pathOid(c);
        const parents: { oid: string; same: boolean }[] = [];
        for (const p of c.parents) {
          const pc = await this.readCommit(p);
          parents.push({ oid: p, same: pc ? (await pathOid(pc)) === mine : false });
        }
        const same = parents.find((p) => p.same);
        if (same) {
          include = false;
          follow = [same.oid];
        } else {
          include = parents.length > 0 || mine !== null;
        }
      }
      if (include) {
        if (skip > 0) skip--;
        else out.push({ oid, commit: c });
      }
      for (const p of follow) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pc = await this.readCommit(p);
        if (pc) queue.push(p, pc.committer.time);
      }
    }
    return out;
  }
}
