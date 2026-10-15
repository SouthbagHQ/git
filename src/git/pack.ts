// Pack files (v2): reading (all object types, OFS_DELTA and REF_DELTA incl. thin packs) and
// writing (full objects only, no deltas).

import { inflateZlib } from './inflate';
import {
  concatBytes,
  fromUtf8,
  hashObject,
  PACK_TYPE,
  PACK_TYPE_NAME,
  sha1Hex,
  toHex,
  utf8,
  type GitObject,
  type ObjectType,
} from './objects';

export interface PackedObject extends GitObject {
  oid: string;
}

/** Looks up delta bases that are not in the pack (thin packs). */
export type BaseResolver = (oids: string[]) => Promise<Map<string, GitObject>>;

const OFS_DELTA = 6;
const REF_DELTA = 7;

interface Entry {
  offset: number;
  type: number;
  data: Uint8Array; // inflated: object data or delta
  baseOffset?: number;
  baseOid?: string;
  resolved?: PackedObject;
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let c: number;
  do {
    c = buf[pos++];
    result += (c & 0x7f) * 2 ** shift;
    shift += 7;
  } while (c & 0x80);
  return [result, pos];
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let [srcSize, pos] = readVarint(delta, 0);
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  let dstSize: number;
  [dstSize, pos] = readVarint(delta, pos);
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      if (cmd & 0x01) off |= delta[pos++];
      if (cmd & 0x02) off |= delta[pos++] << 8;
      if (cmd & 0x04) off |= delta[pos++] << 16;
      if (cmd & 0x08) off += delta[pos++] * 0x1000000;
      if (cmd & 0x10) size |= delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error('delta copy out of range');
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (cmd) {
      if (o + cmd > dstSize || pos + cmd > delta.length) throw new Error('delta insert out of range');
      out.set(delta.subarray(pos, pos + cmd), o);
      o += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (o !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

/** Parse a pack into its objects (deltas resolved, ids computed). Verifies the SHA-1 trailer. */
export async function parsePack(pack: Uint8Array, resolveBases: BaseResolver): Promise<PackedObject[]> {
  if (pack.length < 32 || fromUtf8(pack.subarray(0, 4)) !== 'PACK') throw new Error('not a pack file');
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8);
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let c = pack[pos++];
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = pack[pos++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Entry = { offset, type, data: new Uint8Array(0) };
    if (type === OFS_DELTA) {
      c = pack[pos++];
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++];
        ofs = (ofs + 1) * 128 + (c & 0x7f);
      }
      entry.baseOffset = offset - ofs;
    } else if (type === REF_DELTA) {
      entry.baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!PACK_TYPE_NAME[type]) {
      throw new Error(`bad object type ${type} in pack`);
    }
    const r = inflateZlib(pack, pos, size);
    if (r.data.length !== size) throw new Error('pack object size mismatch');
    entry.data = r.data;
    pos = r.end;
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  if (pos + 20 > pack.length) throw new Error('pack truncated');
  const expected = toHex(pack.subarray(pos, pos + 20));
  const actual = await sha1Hex(pack.subarray(0, pos));
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const byOid = new Map<string, GitObject>();
  const finish = async (e: Entry, type: ObjectType, data: Uint8Array) => {
    const oid = await hashObject(type, data);
    e.resolved = { oid, type, data };
    byOid.set(oid, e.resolved);
  };
  for (const e of entries) {
    if (e.type !== OFS_DELTA && e.type !== REF_DELTA) {
      await finish(e, PACK_TYPE_NAME[e.type], e.data);
    }
  }
  let pending = entries.filter((e) => !e.resolved);
  let fetchedExternal = false;
  while (pending.length) {
    let progress = false;
    for (const e of pending) {
      const base = e.baseOffset !== undefined ? byOffset.get(e.baseOffset)?.resolved : byOid.get(e.baseOid!);
      if (e.baseOffset !== undefined && !byOffset.has(e.baseOffset)) throw new Error('bad delta base offset');
      if (!base) continue;
      await finish(e, base.type, applyDelta(base.data, e.data));
      progress = true;
    }
    pending = pending.filter((e) => !e.resolved);
    if (!progress && pending.length) {
      if (fetchedExternal) throw new Error('pack has deltas against missing objects');
      fetchedExternal = true;
      const want = [...new Set(pending.filter((e) => e.baseOid && !byOid.has(e.baseOid)).map((e) => e.baseOid!))];
      const found = await resolveBases(want);
      for (const [oid, obj] of found) byOid.set(oid, obj);
    }
  }
  return entries.map((e) => e.resolved!);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let c = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(c | 0x80);
    c = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(c);
  return new Uint8Array(bytes);
}

/** Build a v2 pack of full (undeltified) objects. */
export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(utf8('PACK'), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const chunks: Uint8Array[] = [header];
  const BATCH = 64;
  for (let i = 0; i < objects.length; i += BATCH) {
    const slice = objects.slice(i, i + BATCH);
    const compressed = await Promise.all(slice.map((o) => deflate(o.data)));
    slice.forEach((o, j) => {
      chunks.push(objectHeader(PACK_TYPE[o.type], o.data.length), compressed[j]);
    });
  }
  const body = concatBytes(chunks);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  return concatBytes([body, digest]);
}
