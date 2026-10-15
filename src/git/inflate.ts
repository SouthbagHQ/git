// A compact RFC 1950/1951 inflater (after Mark Adler's puff.c) that reports how many input bytes
// it consumed. Pack files concatenate zlib streams without storing their compressed lengths, and
// DecompressionStream cannot tell us where a stream ended, so unpacking needs this.

class Huffman {
  counts = new Uint16Array(16);
  symbols: Uint16Array;
  constructor(n: number) {
    this.symbols = new Uint16Array(n);
  }
}

const offs = new Uint16Array(16);

function buildHuffman(h: Huffman, lengths: Uint8Array, start: number, n: number): void {
  h.counts.fill(0);
  for (let i = 0; i < n; i++) h.counts[lengths[start + i]]++;
  h.counts[0] = 0;
  offs[1] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + h.counts[len];
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[start + sym];
    if (len !== 0) h.symbols[offs[len]++] = sym;
  }
}

const LEN_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LEN_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLen: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!fixedLen || !fixedDist) {
    const l = new Uint8Array(288 + 30);
    let i = 0;
    for (; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    for (; i < 318; i++) l[i] = 5;
    fixedLen = new Huffman(288);
    buildHuffman(fixedLen, l, 0, 288);
    fixedDist = new Huffman(30);
    buildHuffman(fixedDist, l, 288, 30);
  }
  return [fixedLen, fixedDist];
}

export interface InflateResult {
  data: Uint8Array;
  /** Offset of the first byte after the stream (after the Adler-32 trailer for zlib). */
  end: number;
}

/** Inflate a raw DEFLATE stream starting at `start`. `sizeHint` preallocates the output. */
export function inflateRaw(src: Uint8Array, start: number, sizeHint = 0): InflateResult {
  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : 1024);
  let outPos = 0;

  const fail = (msg: string): never => {
    throw new Error(`inflate: ${msg}`);
  };
  const bits = (n: number): number => {
    while (bitcnt < n) {
      if (pos >= src.length) fail('unexpected end of input');
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };
  const ensure = (n: number) => {
    if (outPos + n <= out.length) return;
    let size = out.length * 2;
    while (size < outPos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outPos));
    out = next;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    const counts = h.counts;
    for (let len = 1; len <= 15; len++) {
      if (bitcnt === 0) {
        if (pos >= src.length) fail('unexpected end of input');
        bitbuf = src[pos++];
        bitcnt = 8;
      }
      code |= bitbuf & 1;
      bitbuf >>>= 1;
      bitcnt--;
      const count = counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    return fail('invalid huffman code');
  };
  const codes = (lencode: Huffman, distcode: Huffman) => {
    for (;;) {
      let sym = decode(lencode);
      if (sym < 256) {
        if (outPos >= out.length) ensure(1);
        out[outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) fail('invalid length symbol');
        const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
        const dsym = decode(distcode);
        if (dsym >= 30) fail('invalid distance symbol');
        const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
        if (dist > outPos) fail('distance too far back');
        ensure(len);
        let from = outPos - dist;
        if (dist >= len) {
          out.copyWithin(outPos, from, from + len);
          outPos += len;
        } else {
          for (let i = 0; i < len; i++) out[outPos++] = out[from++];
        }
      }
    }
  };

  const lengths = new Uint8Array(320);
  const dynLen = new Huffman(288);
  const dynDist = new Huffman(30);
  const clCode = new Huffman(19);

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > src.length) fail('unexpected end of input');
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      if (len !== (~nlen & 0xffff)) fail('stored block length mismatch');
      pos += 4;
      if (pos + len > src.length) fail('unexpected end of input');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outPos);
      outPos += len;
      pos += len;
    } else if (type === 1) {
      const [l, d] = fixedTables();
      codes(l, d);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) fail('bad counts');
      lengths.fill(0);
      for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = bits(3);
      buildHuffman(clCode, lengths, 0, 19);
      let index = 0;
      const total = nlen + ndist;
      const ll = new Uint8Array(total);
      while (index < total) {
        let sym = decode(clCode);
        if (sym < 16) {
          ll[index++] = sym;
        } else {
          let len = 0;
          if (sym === 16) {
            if (index === 0) fail('repeat with no first length');
            len = ll[index - 1];
            sym = 3 + bits(2);
          } else if (sym === 17) sym = 3 + bits(3);
          else sym = 11 + bits(7);
          if (index + sym > total) fail('too many lengths');
          while (sym--) ll[index++] = len;
        }
      }
      buildHuffman(dynLen, ll, 0, nlen);
      buildHuffman(dynDist, ll, nlen, ndist);
      codes(dynLen, dynDist);
    } else {
      fail('invalid block type');
    }
  } while (!last);

  // Any bits left over belong to the last byte read; `pos` is the next unread byte.
  return { data: out.length === outPos ? out : out.subarray(0, outPos), end: pos };
}

/** Inflate a zlib stream (RFC 1950) starting at `start`; `end` is after the Adler-32 trailer. */
export function inflateZlib(src: Uint8Array, start: number, sizeHint = 0): InflateResult {
  if (start + 2 > src.length) throw new Error('inflate: unexpected end of input');
  const cmf = src[start];
  const flg = src[start + 1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error('inflate: bad zlib header');
  if (flg & 0x20) throw new Error('inflate: preset dictionary not supported');
  const r = inflateRaw(src, start + 2, sizeHint);
  return { data: r.data, end: r.end + 4 };
}
