// pkt-line framing and side-band multiplexing for the git smart HTTP protocol.

import { concatBytes, fromUtf8, utf8 } from './objects';

export const FLUSH = utf8('0000');
export const DELIM = utf8('0001');

/** Max payload of a pkt-line (65520 total minus the 4-byte length). */
export const MAX_PKT_DATA = 65516;

export function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === 'string' ? utf8(data) : data;
  if (body.length > MAX_PKT_DATA) throw new Error('pkt-line too long');
  const out = new Uint8Array(body.length + 4);
  out.set(utf8((body.length + 4).toString(16).padStart(4, '0')), 0);
  out.set(body, 4);
  return out;
}

export type Pkt = { kind: 'data'; data: Uint8Array } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export class PktReader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  next(): Pkt {
    if (this.pos + 4 > this.buf.length) return { kind: 'end' };
    const len = parseInt(fromUtf8(this.buf.subarray(this.pos, this.pos + 4)), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      this.pos += 4;
      return { kind: 'flush' };
    }
    if (len === 1 || len === 2) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (len < 4 || this.pos + len > this.buf.length) throw new Error('truncated pkt-line');
    const data = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return { kind: 'data', data };
  }

  /** Bytes after the current position (e.g. the pack after receive-pack commands). */
  rest(): Uint8Array {
    return this.buf.subarray(this.pos);
  }
}

/** Text of a data pkt without its trailing newline. */
export function pktText(data: Uint8Array): string {
  const s = fromUtf8(data);
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** Wrap bytes in side-band-64k packets on `channel` (1 data, 2 progress, 3 error). */
export function sideband(channel: 1 | 2 | 3, data: Uint8Array | string): Uint8Array[] {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const max = 65515;
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += max) {
    const chunk = bytes.subarray(i, Math.min(i + max, bytes.length));
    const p = new Uint8Array(chunk.length + 1);
    p[0] = channel;
    p.set(chunk, 1);
    out.push(pkt(p));
  }
  return out;
}

export { concatBytes };
