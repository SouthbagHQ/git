// Tree diffs and line diffs (Myers) for commit pages, merge request pages and push analysis.

import { fromUtf8, isBinary, isGitlinkMode, isTreeMode, type GitObject, type TreeEntry } from './objects';
import type { ObjectStore } from './store';

export type ChangeStatus = 'added' | 'deleted' | 'modified';

export interface TreeChange {
  path: string;
  status: ChangeStatus;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
}

export interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff extends TreeChange {
  binary: boolean;
  hunks: Hunk[];
  added: number;
  deleted: number;
  /** Hunks were cut off (output budget used up, file too large, or diff too complex). */
  truncated: boolean;
}

export interface CommitDiff {
  oid: string;
  parent: string | null;
  files: FileDiff[];
  added: number;
  deleted: number;
  /** Some files or lines were left out to stay within the output budget. */
  truncated: boolean;
}

const MAX_DIFF_FILE = 1_000_000;

// ---- tree diff ----

/** Changed files between two trees (null = empty tree), recursive, sorted by path. */
export async function diffTrees(store: ObjectStore, oldTree: string | null, newTree: string | null): Promise<TreeChange[]> {
  const out: TreeChange[] = [];
  const walk = async (a: string | null, b: string | null, prefix: string) => {
    if (a === b) return;
    const [ea, eb] = await Promise.all([a ? store.readTree(a) : [], b ? store.readTree(b) : []]);
    if (!ea || !eb) throw new Error('missing tree');
    const ma = new Map<string, TreeEntry>(ea.map((e) => [e.name, e]));
    const mb = new Map<string, TreeEntry>(eb.map((e) => [e.name, e]));
    const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    for (const name of names) {
      const x = ma.get(name);
      const y = mb.get(name);
      const path = prefix + name;
      if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
      const xt = !!x && isTreeMode(x.mode);
      const yt = !!y && isTreeMode(y.mode);
      if (xt || yt) {
        await walk(xt ? x!.oid : null, yt ? y!.oid : null, path + '/');
      }
      const xf = x && !xt ? x : null;
      const yf = y && !yt ? y : null;
      if (xf && yf) out.push({ path, status: 'modified', oldMode: xf.mode, newMode: yf.mode, oldOid: xf.oid, newOid: yf.oid });
      else if (xf) out.push({ path, status: 'deleted', oldMode: xf.mode, newMode: null, oldOid: xf.oid, newOid: null });
      else if (yf) out.push({ path, status: 'added', oldMode: null, newMode: yf.mode, oldOid: null, newOid: yf.oid });
    }
  };
  await walk(oldTree, newTree, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- line diff ----

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Myers line diff. Returns the full edit script (context lines included). Falls back to
 * "delete everything, add everything" when the edit distance exceeds `maxD` (returns
 * `complete: false`).
 */
export function diffLines(a: string[], b: string[], maxD = 1000): { edits: DiffLine[]; complete: boolean } {
  // Map lines to ints for fast comparison.
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = Int32Array.from(a, id);
  const B = Int32Array.from(b, id);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf;
  const m = B.length - pre - suf;
  const mid: ('=' | '+' | '-')[] = [];
  let complete = true;

  if (n === 0) for (let i = 0; i < m; i++) mid.push('+');
  else if (m === 0) for (let i = 0; i < n; i++) mid.push('-');
  else {
    const off = maxD + 1;
    const v = new Int32Array(2 * maxD + 3);
    const trace: Int32Array[] = [];
    let found = -1;
    outer: for (let d = 0; d <= maxD; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[pre + x] === B[pre + y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          trace.push(v.slice(off - d, off + d + 1));
          found = d;
          break outer;
        }
      }
      trace.push(v.slice(off - d, off + d + 1));
    }
    if (found < 0) {
      complete = false;
      for (let i = 0; i < n; i++) mid.push('-');
      for (let i = 0; i < m; i++) mid.push('+');
    } else {
      const rev: ('=' | '+' | '-')[] = [];
      let x = n;
      let y = m;
      for (let d = found; d > 0; d--) {
        const vp = trace[d - 1];
        const at = (k: number) => vp[k + d - 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          rev.push('=');
          x--;
          y--;
        }
        if (x === prevX) rev.push('+');
        else rev.push('-');
        x = prevX;
        y = prevY;
      }
      while (x > 0 && y > 0) {
        rev.push('=');
        x--;
        y--;
      }
      mid.push(...rev.reverse());
    }
  }

  const edits: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (let p = 0; p < pre; p++, i++, j++) edits.push({ kind: ' ', text: a[i], oldNo: i + 1, newNo: j + 1 });
  for (const op of mid) {
    if (op === '=') {
      edits.push({ kind: ' ', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (op === '-') {
      edits.push({ kind: '-', text: a[i], oldNo: i + 1, newNo: null });
      i++;
    } else {
      edits.push({ kind: '+', text: b[j], oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  for (let p = 0; p < suf; p++, i++, j++) edits.push({ kind: ' ', text: a[i], oldNo: i + 1, newNo: j + 1 });
  return { edits, complete };
}

/** Group an edit script into unified-diff hunks with `context` lines around changes. */
export function toHunks(edits: DiffLine[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const changes: number[] = [];
  edits.forEach((e, i) => e.kind !== ' ' && changes.push(i));
  let ci = 0;
  while (ci < changes.length) {
    const start = Math.max(0, changes[ci] - context);
    let end = changes[ci];
    while (ci + 1 < changes.length && changes[ci + 1] - end <= 2 * context) end = changes[++ci];
    ci++;
    const stop = Math.min(edits.length, end + context + 1);
    const lines = edits.slice(start, stop);
    // Count old/new lines before the hunk.
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = start - 1; i >= 0; i--) {
      const e = edits[i];
      if (e.oldNo !== null && !oldBefore) oldBefore = e.oldNo;
      if (e.newNo !== null && !newBefore) newBefore = e.newNo;
      if (oldBefore && newBefore) break;
    }
    const oldLen = lines.filter((l) => l.kind !== '+').length;
    const newLen = lines.filter((l) => l.kind !== '-').length;
    const oldStart = oldLen ? oldBefore + 1 : oldBefore;
    const newStart = newLen ? newBefore + 1 : newBefore;
    hunks.push({ header: `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, lines });
  }
  return hunks;
}

// ---- file and commit diffs ----

async function blobText(
  store: ObjectStore,
  oid: string | null,
  mode: string | null,
  prefetched?: Map<string, GitObject>,
): Promise<{ text: string; binary: boolean; large: boolean }> {
  if (!oid || !mode || isGitlinkMode(mode)) return { text: oid && mode ? `Subproject commit ${oid}\n` : '', binary: false, large: false };
  const pre = prefetched?.get(oid);
  const data = pre ? (pre.type === 'blob' ? pre.data : null) : await store.readBlob(oid);
  if (!data) return { text: '', binary: true, large: false };
  if (isBinary(data)) return { text: '', binary: true, large: false };
  if (data.length > MAX_DIFF_FILE) return { text: '', binary: false, large: true };
  return { text: fromUtf8(data), binary: false, large: false };
}

/**
 * Full diff between two trees (null = empty). Output is capped at `maxLines` diff lines in
 * total; files past the budget are listed without hunks and marked truncated.
 */
export async function diffTreeFiles(
  store: ObjectStore,
  oldTree: string | null,
  newTree: string | null,
  opts: { maxLines?: number; context?: number; maxFiles?: number } = {},
): Promise<{ files: FileDiff[]; added: number; deleted: number; truncated: boolean }> {
  let budget = opts.maxLines ?? 3000;
  const maxFiles = opts.maxFiles ?? 300;
  const changes = await diffTrees(store, oldTree, newTree);
  const files: FileDiff[] = [];
  let truncated = changes.length > maxFiles;
  let added = 0;
  let deleted = 0;
  const wanted = changes.slice(0, maxFiles);
  await store.getMany(
    wanted.flatMap((c) => [c.oldOid, c.newOid]).filter((o): o is string => !!o),
  );
  for (const c of wanted) {
    const f: FileDiff = { ...c, binary: false, hunks: [], added: 0, deleted: 0, truncated: false };
    files.push(f);
    const [x, y] = await Promise.all([blobText(store, c.oldOid, c.oldMode), blobText(store, c.newOid, c.newMode)]);
    if (x.binary || y.binary) {
      f.binary = true;
      continue;
    }
    if (x.large || y.large) {
      f.truncated = truncated = true;
      continue;
    }
    const { edits, complete } = diffLines(splitLines(x.text), splitLines(y.text));
    for (const e of edits) {
      if (e.kind === '+') f.added++;
      else if (e.kind === '-') f.deleted++;
    }
    added += f.added;
    deleted += f.deleted;
    if (!complete) f.truncated = true;
    if (budget <= 0) {
      f.truncated = truncated = true;
      continue;
    }
    let hunks = toHunks(edits, opts.context ?? 3);
    let lines = hunks.reduce((n, h) => n + h.lines.length, 0);
    if (lines > budget) {
      const kept: Hunk[] = [];
      let used = 0;
      for (const h of hunks) {
        if (used + h.lines.length > budget) {
          if (!kept.length) kept.push({ header: h.header, lines: h.lines.slice(0, budget) });
          break;
        }
        kept.push(h);
        used += h.lines.length;
      }
      hunks = kept;
      lines = budget;
      f.truncated = truncated = true;
    }
    f.hunks = hunks;
    budget -= lines;
  }
  return { files, added, deleted, truncated };
}

/** A commit's changes against its first parent (or the empty tree for a root commit). */
export async function diffCommit(
  store: ObjectStore,
  oid: string,
  opts: { maxLines?: number; context?: number; maxFiles?: number } = {},
): Promise<CommitDiff> {
  const commit = await store.readCommit(oid);
  if (!commit) throw new Error(`no such commit ${oid}`);
  const parent = commit.parents[0] ?? null;
  const parentTree = parent ? (await store.readCommit(parent))?.tree ?? null : null;
  const d = await diffTreeFiles(store, parentTree, commit.tree, opts);
  return { oid, parent, ...d };
}

export interface DiffStats {
  filesAdded: number;
  filesDeleted: number;
  filesModified: number;
  linesAdded: number;
  linesDeleted: number;
}

/**
 * File and line counts between two trees. Line counting is capped (first `maxFiles` text files
 * under 1 MB); binary files count 0 lines.
 */
export async function diffStats(
  store: ObjectStore,
  oldTree: string | null,
  newTree: string | null,
  opts: { maxFiles?: number } = {},
): Promise<DiffStats> {
  const changes = await diffTrees(store, oldTree, newTree);
  const stats: DiffStats = { filesAdded: 0, filesDeleted: 0, filesModified: 0, linesAdded: 0, linesDeleted: 0 };
  for (const c of changes) {
    if (c.status === 'added') stats.filesAdded++;
    else if (c.status === 'deleted') stats.filesDeleted++;
    else stats.filesModified++;
  }
  const counted = changes.slice(0, opts.maxFiles ?? 200);
  const blobs = await store.getMany(
    counted.flatMap((c) => [c.oldOid, c.newOid]).filter((o): o is string => !!o),
    { cache: false },
  );
  for (const c of counted) {
    const [x, y] = await Promise.all([
      blobText(store, c.oldOid, c.oldMode, blobs),
      blobText(store, c.newOid, c.newMode, blobs),
    ]);
    if (x.binary || y.binary || x.large || y.large) continue;
    const a = splitLines(x.text);
    const b = splitLines(y.text);
    if (!a.length) stats.linesAdded += b.length;
    else if (!b.length) stats.linesDeleted += a.length;
    else {
      const { edits } = diffLines(a, b, 500);
      for (const e of edits) {
        if (e.kind === '+') stats.linesAdded++;
        else if (e.kind === '-') stats.linesDeleted++;
      }
    }
  }
  return stats;
}
