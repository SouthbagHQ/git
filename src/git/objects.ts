// Git object model: hashing, and parsing/serializing commits, trees, tags and person lines.
// Objects are stored uncompressed; an object's id is SHA-1 over "<type> <size>\0" + data.

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

/** `Name <email> 1700000000 +1000`. time is unix seconds. */
export interface Person {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
  /** Other headers (encoding, gpgsig, mergetag, ...) in order; values without continuation spaces. */
  extra?: [string, string][];
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: Person | null;
  message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const MODE = {
  file: '100644',
  executable: '100755',
  symlink: '120000',
  tree: '40000',
  gitlink: '160000',
} as const;

export const isTreeMode = (mode: string): boolean => mode === '40000' || mode === '040000';
export const isGitlinkMode = (mode: string): boolean => mode === '160000';
export const isOid = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);

export const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', data)));
}

export async function hashObject(type: ObjectType, data: Uint8Array): Promise<string> {
  const header = utf8(`${type} ${data.length}\0`);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header, 0);
  buf.set(data, header.length);
  return sha1Hex(buf);
}

// ---- person lines ----

export function parsePerson(line: string): Person {
  const m = /^(.*?) ?<([^>]*)> ?(\d+)? ?([+-]\d{4})?\s*$/.exec(line);
  if (!m) return { name: line, email: '', time: 0, tz: '+0000' };
  return { name: m[1], email: m[2], time: m[3] ? Number(m[3]) : 0, tz: m[4] ?? '+0000' };
}

export function formatPerson(p: Person): string {
  return `${p.name} <${p.email}> ${Math.floor(p.time)} ${p.tz}`;
}

/** Offset string for a JS Date's local zone is meaningless in Workers (UTC); helper for explicit offsets. */
export function tzFromMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

// ---- commits ----

function splitHeaders(text: string): { headers: [string, string][]; message: string } {
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  const message = end < 0 ? '' : text.slice(end + 2);
  const headers: [string, string][] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length) {
      headers[headers.length - 1][1] += '\n' + line.slice(1);
    } else if (line) {
      const sp = line.indexOf(' ');
      headers.push(sp < 0 ? [line, ''] : [line.slice(0, sp), line.slice(sp + 1)]);
    }
  }
  return { headers, message };
}

export function parseCommit(data: Uint8Array): Commit {
  const { headers, message } = splitHeaders(fromUtf8(data));
  const commit: Commit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', time: 0, tz: '+0000' },
    committer: { name: '', email: '', time: 0, tz: '+0000' },
    message,
  };
  const extra: [string, string][] = [];
  for (const [k, v] of headers) {
    if (k === 'tree') commit.tree = v;
    else if (k === 'parent') commit.parents.push(v);
    else if (k === 'author') commit.author = parsePerson(v);
    else if (k === 'committer') commit.committer = parsePerson(v);
    else extra.push([k, v]);
  }
  if (extra.length) commit.extra = extra;
  return commit;
}

export function serializeCommit(c: Commit): Uint8Array {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${formatPerson(c.author)}\n`;
  s += `committer ${formatPerson(c.committer)}\n`;
  for (const [k, v] of c.extra ?? []) s += `${k} ${v.replaceAll('\n', '\n ')}\n`;
  s += '\n' + c.message;
  return utf8(s);
}

// ---- trees ----

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree object');
    const mode = fromUtf8(data.subarray(pos, sp));
    const name = fromUtf8(data.subarray(sp + 1, nul));
    const oid = toHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Git's tree order: byte order of names, with trees compared as if their name ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry) => utf8(isTreeMode(e.mode) ? e.name + '/' : e.name);
  return entries
    .map((e) => ({ e, k: key(e) }))
    .sort((a, b) => compareBytes(a.k, b.k))
    .map((x) => x.e);
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of sortTreeEntries(entries)) {
    const mode = isTreeMode(e.mode) ? '40000' : e.mode;
    chunks.push(utf8(`${mode} ${e.name}\0`), fromHex(e.oid));
  }
  return concatBytes(chunks);
}

// ---- tags ----

export function parseTag(data: Uint8Array): Tag {
  const { headers, message } = splitHeaders(fromUtf8(data));
  const tag: Tag = { object: '', type: 'commit', tag: '', tagger: null, message };
  for (const [k, v] of headers) {
    if (k === 'object') tag.object = v;
    else if (k === 'type') tag.type = v as ObjectType;
    else if (k === 'tag') tag.tag = v;
    else if (k === 'tagger') tag.tagger = parsePerson(v);
  }
  return tag;
}

export function serializeTag(t: Tag): Uint8Array {
  let s = `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\n`;
  if (t.tagger) s += `tagger ${formatPerson(t.tagger)}\n`;
  s += '\n' + t.message;
  return utf8(s);
}

/** Pack type numbers. */
export const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const PACK_TYPE_NAME: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Heuristic used by git: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
