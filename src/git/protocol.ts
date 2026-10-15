// Git smart HTTP, protocol v0 (stateless RPC): ref advertisements, upload-pack (clone/fetch)
// and receive-pack (push). Policy (auth, fees, requests, ref moves) is injected by the caller;
// this module only speaks git.

import type { Env, Repo } from '../env';
import type { PushAnalysis, PushedCommit, RefUpdate, Verdict } from '../lib/policy';
import { diffStats } from './diff';
import { FLOOR3_REF, isFloor3Ref } from './floor3';
import { concatBytes, isOid, isTreeMode, isGitlinkMode, parseTag, ZERO_OID, type GitObject } from './objects';
import { buildPack, parsePack } from './pack';
import { FLUSH, pkt, PktReader, pktText, sideband } from './pktline';
import { listRefs, listStoredRefs, setRef, type Ref } from './refs';
import { ObjectStore } from './store';

export const AGENT = 'southbag-git/1.0';
export type Service = 'git-upload-pack' | 'git-receive-pack';

/** What the transport asks of the rules. src/routes/git.ts wires these to src/lib/policy.ts. */
export interface GitPolicy {
  /** Before the upload-pack ref advertisement (src/routes/git.ts calls it). */
  beforeListRefs(): Promise<Verdict>;
  /** Before a pack is sent. */
  beforeFetch(): Promise<Verdict>;
  beforePush(): Promise<Verdict>;
  reviewPush(analyses: PushAnalysis[]): Promise<{ results: Record<string, string | null>; messages: string[] }>;
  /** DEV ONLY: move refs for ok'd updates ourselves (production leaves that to reviewPush/pushes.ts). */
  applyRefs?: boolean;
}

const UPLOAD_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'ofs-delta',
  'no-progress',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
];
const RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet'];

const isZero = (oid: string) => oid === ZERO_OID;

// ---- advertisement ----

export function serviceHeader(service: Service): Uint8Array {
  return concatBytes([pkt(`# service=${service}\n`), FLUSH]);
}

/** The advertisement used to refuse a service: git prints `fatal: remote error: <message>`. */
export function errorAdvertisement(service: Service, message: string): Uint8Array {
  return concatBytes([serviceHeader(service), pkt(`ERR ${message}\n`)]);
}

export async function advertiseRefs(env: Env, repo: Repo, service: Service, store: ObjectStore): Promise<Uint8Array> {
  const stored = await listStoredRefs(env, repo.id);
  const lines: string[] = [];
  let caps: string[];
  let refs: Ref[];
  if (service === 'git-upload-pack') {
    // An empty repository is advertised as empty (so `git clone` says so), floor-3 or not.
    refs = stored.length ? await listRefs(env, repo) : [];
    const head =
      refs.find((r) => r.name === `refs/heads/${repo.default_branch}`) ??
      refs.find((r) => r.name.startsWith('refs/heads/') && r.name !== FLOOR3_REF);
    caps = [...UPLOAD_CAPS];
    if (head) {
      caps.push(`symref=HEAD:${head.name}`);
      lines.push(`${head.oid} HEAD`);
    }
  } else {
    refs = await listRefs(env, repo);
    caps = [...RECEIVE_CAPS];
  }
  caps.push(`agent=${AGENT}`);
  // Peel annotated tags.
  const tagRefs = refs.filter((r) => r.name.startsWith('refs/tags/'));
  const objs = tagRefs.length ? await store.getMany(tagRefs.map((r) => r.oid)) : new Map<string, GitObject>();
  for (const r of refs) {
    lines.push(`${r.oid} ${r.name}`);
    const obj = objs.get(r.oid);
    if (obj?.type === 'tag') {
      const peeled = await store.peel(r.oid);
      if (peeled) lines.push(`${peeled} ${r.name}^{}`);
    }
  }
  if (!lines.length) lines.push(`${ZERO_OID} capabilities^{}`);
  const out: Uint8Array[] = [serviceHeader(service)];
  lines.forEach((line, i) => out.push(pkt(i === 0 ? `${line}\0${caps.join(' ')}\n` : `${line}\n`)));
  out.push(FLUSH);
  return concatBytes(out);
}

// ---- upload-pack ----

/** Trees and blobs reachable from `roots` that are not in `seen` (which is updated). */
async function collectTreeObjects(store: ObjectStore, roots: string[], seen: Set<string>) {
  const trees: string[] = [];
  const blobs: string[] = [];
  let level = roots.filter((o) => !seen.has(o) && seen.add(o));
  while (level.length) {
    trees.push(...level);
    await store.getMany(level);
    const next: string[] = [];
    for (const oid of level) {
      const entries = await store.readTree(oid);
      if (!entries) throw new Error(`missing tree ${oid}`);
      for (const e of entries) {
        if (seen.has(e.oid) || isGitlinkMode(e.mode)) continue;
        seen.add(e.oid);
        if (isTreeMode(e.mode)) next.push(e.oid);
        else blobs.push(e.oid);
      }
    }
    level = next;
  }
  return { trees, blobs };
}

/** Every object needed for `wants` minus what the client has (`haves`). */
export async function objectsForFetch(store: ObjectStore, wants: string[], haves: string[]): Promise<GitObject[]> {
  const wantObjs = await store.getMany(wants);
  const tags: string[] = [];
  const extraTrees: string[] = [];
  const extraBlobs: string[] = [];
  for (const w of wants) {
    let oid = w;
    for (let i = 0; i < 10; i++) {
      const obj = wantObjs.get(oid) ?? (await store.get(oid));
      if (!obj) break;
      if (obj.type === 'tag') {
        tags.push(oid);
        oid = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'tree') extraTrees.push(oid);
      if (obj.type === 'blob') extraBlobs.push(oid);
      break;
    }
  }
  const commits = await store.revList(wants, haves);
  const included = new Set(commits);
  const boundary = new Set<string>();
  for (const oid of commits) {
    for (const p of (await store.readCommit(oid))!.parents) if (!included.has(p)) boundary.add(p);
  }
  for (const h of haves) boundary.add(h);
  const seen = new Set<string>();
  const boundaryTrees: string[] = [];
  for (const b of boundary) {
    const c = await store.readCommit(b);
    if (c) boundaryTrees.push(c.tree);
  }
  await store.readCommits([...boundary]);
  await collectTreeObjects(store, boundaryTrees, seen);
  const roots: string[] = [...extraTrees];
  for (const oid of commits) roots.push((await store.readCommit(oid))!.tree);
  const { trees, blobs } = await collectTreeObjects(store, roots, seen);
  for (const b of extraBlobs) if (!seen.has(b)) blobs.push(b);

  const out: GitObject[] = [];
  const push = async (oids: string[], cache: boolean) => {
    for (let i = 0; i < oids.length; i += 40) {
      const chunk = oids.slice(i, i + 40);
      const got = await store.getMany(chunk, { cache });
      for (const oid of chunk) {
        const obj = got.get(oid);
        if (!obj) throw new Error(`missing object ${oid}`);
        out.push(obj);
      }
    }
  };
  await push(commits, true);
  await push([...new Set(tags)], true);
  await push(trees, true);
  await push(blobs, false);
  return out;
}

export async function uploadPack(store: ObjectStore, body: Uint8Array, policy: GitPolicy): Promise<Uint8Array> {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const caps = new Set<string>();
  for (;;) {
    const p = reader.next();
    if (p.kind !== 'data') break;
    const line = pktText(p.data);
    if (line.startsWith('want ')) {
      const [, oid, ...rest] = line.split(' ');
      wants.push(oid);
      if (wants.length === 1) for (const c of rest) caps.add(c);
    }
    // shallow / deepen / filter are not advertised; ignore if sent.
  }
  const haves: string[] = [];
  let done = false;
  for (;;) {
    const p = reader.next();
    if (p.kind !== 'data') break;
    const line = pktText(p.data);
    if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line === 'done') {
      done = true;
      break;
    }
  }
  if (!wants.length) return new Uint8Array(0);
  for (const w of wants) if (!isOid(w)) return pkt(`ERR upload-pack: invalid want ${w}\n`);
  const present = await store.has([...wants, ...haves]);
  for (const w of wants) if (!present.has(w)) return pkt(`ERR upload-pack: not our ref ${w}\n`);

  const multiAck = caps.has('multi_ack_detailed') ? 2 : caps.has('multi_ack') ? 1 : 0;
  const common = haves.filter((h) => present.has(h));
  const out: Uint8Array[] = [];
  for (const h of common) {
    if (multiAck === 2) out.push(pkt(`ACK ${h} common\n`));
    else if (multiAck === 1) out.push(pkt(`ACK ${h} continue\n`));
    else if (h === common[0]) out.push(pkt(`ACK ${h}\n`));
  }
  if (!done) {
    // End of a negotiation round (stateless RPC): no pack yet, so beforeFetch is not called.
    if (!common.length || multiAck) out.push(pkt('NAK\n'));
    return concatBytes(out);
  }

  const verdict = await policy.beforeFetch();
  if (!verdict.ok) return pkt(`ERR ${verdict.message}\n`);
  if (common.length) {
    if (multiAck) out.push(pkt(`ACK ${common[common.length - 1]}\n`));
  } else out.push(pkt('NAK\n'));

  const objects = await objectsForFetch(store, wants, common);
  const pack = await buildPack(objects);
  const band = caps.has('side-band-64k') || caps.has('side-band');
  if (band) {
    if (!caps.has('no-progress')) out.push(...sideband(2, 'Southbag Git: pack prepared. Fees apply.\n'));
    if (caps.has('side-band-64k')) out.push(...sideband(1, pack));
    else for (let i = 0; i < pack.length; i += 999) out.push(...sideband(1, pack.subarray(i, i + 999)));
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return concatBytes(out);
}

// ---- receive-pack ----

function toPushed(oid: string, c: { message: string; author: PushedCommit['author']; committer: PushedCommit['committer']; parents: string[] }): PushedCommit {
  return { oid, message: c.message, author: c.author, committer: c.committer, parents: c.parents };
}

/** Work out what each ref update does (see PushAnalysis in src/lib/policy.ts). */
export async function analyzePush(store: ObjectStore, existingTips: string[], updates: RefUpdate[]): Promise<PushAnalysis[]> {
  const out: PushAnalysis[] = [];
  for (const update of updates) {
    const created = isZero(update.old);
    const deleted = isZero(update.new);
    const a: PushAnalysis = {
      update,
      commits: [],
      forced: false,
      deleted,
      created,
      filesAdded: 0,
      filesDeleted: 0,
      filesModified: 0,
      linesAdded: 0,
      linesDeleted: 0,
    };
    if (!deleted) {
      const oids = await store.revList([update.new], existingTips, { limit: 500 });
      for (const oid of oids) a.commits.push(toPushed(oid, (await store.readCommit(oid))!));
    }
    if (!created && !deleted) {
      const [oldC, newC] = [await store.peel(update.old), await store.peel(update.new)];
      a.forced = !(oldC && newC && (await store.isAncestor(oldC, newC)));
      try {
        const [oldTree, newTree] = [await store.treeOf(update.old), await store.treeOf(update.new)];
        if (oldTree && newTree) Object.assign(a, await diffStats(store, oldTree, newTree));
      } catch {
        // Missing old objects: leave the counts at zero.
      }
    }
    out.push(a);
  }
  return out;
}

export async function receivePack(env: Env, repo: Repo, store: ObjectStore, body: Uint8Array, policy: GitPolicy): Promise<Uint8Array> {
  const reader = new PktReader(body);
  const updates: RefUpdate[] = [];
  const caps = new Set<string>();
  for (;;) {
    const p = reader.next();
    if (p.kind !== 'data') break;
    let line = pktText(p.data);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const c of line.slice(nul + 1).split(' ')) if (c) caps.add(c);
      line = line.slice(0, nul);
    }
    if (line.startsWith('shallow ')) continue;
    const [old, nw, ref] = line.split(' ');
    if (old && nw && ref) updates.push({ old, new: nw, ref });
  }
  const rest = reader.rest();
  const band = caps.has('side-band-64k') || caps.has('side-band');
  const messages: string[] = [];
  const results = new Map<string, string | null>();

  const respond = (unpack: string) => {
    const report = concatBytes([
      pkt(`unpack ${unpack}\n`),
      ...updates.map((u) => {
        const r = results.get(u.ref);
        return pkt(r ? `ng ${u.ref} ${r}\n` : `ok ${u.ref}\n`);
      }),
      FLUSH,
    ]);
    if (!band) return caps.has('report-status') ? report : new Uint8Array(0);
    const out: Uint8Array[] = [];
    if (!caps.has('quiet') || messages.length) {
      for (const m of messages) out.push(...sideband(2, m.endsWith('\n') ? m : m + '\n'));
    }
    if (caps.has('report-status')) out.push(...sideband(1, report));
    out.push(FLUSH);
    return concatBytes(out);
  };

  if (!updates.length) return new Uint8Array(0);

  const verdict = await policy.beforePush();
  if (!verdict.ok) {
    messages.push(verdict.message);
    for (const u of updates) results.set(u.ref, verdict.message);
    return respond('refused');
  }

  // Unpack and store.
  if (rest.length >= 4 && rest[0] === 0x50 && rest[1] === 0x41 && rest[2] === 0x43 && rest[3] === 0x4b) {
    try {
      const objects = await parsePack(rest, (oids) => store.getMany(oids));
      await store.putMany(objects);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const u of updates) results.set(u.ref, 'unpacker error');
      messages.push(`Southbag Git: could not store your objects: ${msg}`);
      return respond(msg.replace(/\n/g, ' '));
    }
  }

  // Validate commands.
  const toReview: RefUpdate[] = [];
  const newOids = updates.filter((u) => !isZero(u.new)).map((u) => u.new);
  const present = await store.has(newOids);
  for (const u of updates) {
    if (isFloor3Ref(u.ref)) results.set(u.ref, 'branch does not exist');
    else if (!u.ref.startsWith('refs/') || !isOid(u.old) || !isOid(u.new)) results.set(u.ref, 'funny refname');
    else if (!isZero(u.new) && !present.has(u.new)) results.set(u.ref, 'missing necessary objects');
    else if (u.ref.startsWith('refs/heads/') && !isZero(u.new) && (await store.get(u.new))?.type !== 'commit')
      results.set(u.ref, 'branch must point at a commit');
    else toReview.push(u);
  }

  if (toReview.length) {
    const tips = (await listRefs(env, repo)).map((r) => r.oid);
    const analyses = await analyzePush(store, tips, toReview);
    const verdicts = await policy.reviewPush(analyses);
    messages.push(...verdicts.messages);
    for (const u of toReview) {
      const r = verdicts.results[u.ref] ?? null;
      results.set(u.ref, r);
      if (!r && policy.applyRefs) {
        await setRef(env, repo.id, u.ref, isZero(u.new) ? null : u.new);
      }
    }
  }
  return respond('ok');
}
