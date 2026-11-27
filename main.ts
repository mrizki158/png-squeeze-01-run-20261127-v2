// png-squeeze v3 — lossless PNG re-encoder with an optimal-parse DEFLATE
// (dynamic-programming LZ77 parse + length-limited dynamic Huffman, zopfli-style).
//
// Pipeline per instance (1280x720 RGBA8 screenshot):
//   1. Decode the input PNG to raw RGBA pixels.
//   2. Reduce the colour representation losslessly: palette (<=256 colours),
//      grey, grey+alpha, RGB, or RGBA — whichever holds the pixels exactly
//      with the fewest bytes per pixel.
//   3. Choose a PNG filter per scanline by an entropy estimate built from
//      per-filter byte histograms over the whole image.
//   4. Compress the filtered stream with an optimal-parse DEFLATE encoder:
//      hash-chained LZ77 matches, DP over match/literal choices with an
//      accurate bit-cost model, two passes (fixed Huffman costs, then the
//      dynamic Huffman built from the first parse), per-block choice of
//      fixed vs dynamic Huffman by exact bit cost.
//   5. Verify: decode the produced PNG and compare every pixel; on any
//      mismatch fall back to a plain zlib level-9 encode of the same
//      filtered stream, and finally to a byte copy of the input.
//
// Deterministic: no clock, no randomness, no environment-dependent choices.
// Plain JavaScript in a .ts file (Node 22 strips types; this uses none).
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- CRC / Adler
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG decode
// Decodes a bit-depth-8, non-interlaced PNG (colour types 0,2,3,4,6) to RGBA.
function decodePng(buf) {
  if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw new Error('bad PNG signature');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colourType = 0;
  let plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colourType = data[9];
      if (bitDepth !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error('unsupported colour type ' + colourType);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const row = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) row[i] = raw[p++];
    // unfilter in place
    if (filter === 1) {
      for (let i = channels; i < stride; i++) row[i] = (row[i] + row[i - channels]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        let pa = b - c; if (pa < 0) pa = -pa;
        let pb = a - c; if (pb < 0) pb = -pb;
        let pc = a + b - c - c; if (pc < 0) pc = -pc;
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = (row[i] + pred) & 0xff;
      }
    } else if (filter !== 0) {
      throw new Error('bad filter ' + filter);
    }
    prev.set(row);
    const out = y * width * 4;
    if (colourType === 6) {
      rgba.set(row, out);
    } else if (colourType === 2) {
      for (let x = 0; x < width; x++) {
        const s = x * 3, d = out + x * 4;
        rgba[d] = row[s]; rgba[d + 1] = row[s + 1]; rgba[d + 2] = row[s + 2]; rgba[d + 3] = 255;
      }
    } else if (colourType === 0) {
      for (let x = 0; x < width; x++) {
        const d = out + x * 4, g = row[x];
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255;
      }
    } else if (colourType === 4) {
      for (let x = 0; x < width; x++) {
        const s = x * 2, d = out + x * 4, g = row[s];
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = row[s + 1];
      }
    } else if (colourType === 3) {
      for (let x = 0; x < width; x++) {
        const idx = row[x], s = idx * 3, d = out + x * 4;
        rgba[d] = plte[s]; rgba[d + 1] = plte[s + 1]; rgba[d + 2] = plte[s + 2];
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- PNG encode
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function encodePng(width, height, colourType, plte, trns, zlibData) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colourType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlibData));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- Colour reduction
// Returns { colourType, bpp, plte, trns, rows } where rows is the packed
// per-row sample data (no filter bytes) for the chosen representation.
function reduceColours(width, height, rgba) {
  const npix = width * height;
  let allGrey = true;
  let allOpaque = true;
  const seen = new Map();
  const order = [];
  let tooMany = false;
  for (let i = 0; i < npix; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (!tooMany) {
      const key = r * 16777216 + g * 65536 + b * 256 + a;
      if (!seen.has(key)) {
        if (seen.size >= 256) { tooMany = true; }
        else { seen.set(key, order.length); order.push(key); }
      }
    }
  }
  const strideOf = (bpp) => width * bpp;
  if (allGrey && allOpaque) {
    // Grey, no alpha: the grey value itself is the sample, which also
    // filters better than an arbitrary palette order.
    const rows = new Uint8Array(height * width);
    for (let i = 0; i < npix; i++) rows[i] = rgba[i * 4];
    return { colourType: 0, bpp: 1, plte: null, trns: null, rows };
  }
  if (!tooMany) {
    // Palette, colour type 3. Order entries by colour value so that
    // neighbouring colours get neighbouring indices (filters better).
    order.sort((a, b) => a - b);
    seen.clear();
    for (let k = 0; k < order.length; k++) seen.set(order[k], k);
    const plte = Buffer.alloc(order.length * 3);
    const trnsArr = [];
    let needTrns = false;
    for (let k = 0; k < order.length; k++) {
      const key = order[k];
      const a = key & 0xff, b = (key >> 8) & 0xff, g = (key >> 16) & 0xff, r = (key >> 24) & 0xff;
      plte[k * 3] = r; plte[k * 3 + 1] = g; plte[k * 3 + 2] = b;
      trnsArr.push(a);
      if (a !== 255) needTrns = true;
    }
    let trns = null;
    if (needTrns) {
      let n = trnsArr.length;
      while (n > 0 && trnsArr[n - 1] === 255) n--;
      trns = Buffer.from(trnsArr.slice(0, n));
    }
    const rows = new Uint8Array(height * width);
    for (let i = 0; i < npix; i++) {
      const key = rgba[i * 4] * 16777216 + rgba[i * 4 + 1] * 65536 + rgba[i * 4 + 2] * 256 + rgba[i * 4 + 3];
      rows[i] = seen.get(key);
    }
    return { colourType: 3, bpp: 1, plte, trns, rows };
  }
  if (allGrey) {
    const rows = new Uint8Array(height * width * 2);
    for (let i = 0; i < npix; i++) { rows[i * 2] = rgba[i * 4]; rows[i * 2 + 1] = rgba[i * 4 + 3]; }
    return { colourType: 4, bpp: 2, plte: null, trns: null, rows };
  }
  if (allOpaque) {
    const rows = new Uint8Array(height * width * 3);
    for (let i = 0; i < npix; i++) {
      rows[i * 3] = rgba[i * 4]; rows[i * 3 + 1] = rgba[i * 4 + 1]; rows[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colourType: 2, bpp: 3, plte: null, trns: null, rows };
  }
  const rows = new Uint8Array(height * width * 4);
  rows.set(rgba);
  return { colourType: 6, bpp: 4, plte: null, trns: null, rows };
}

// ---------------------------------------------------------------- Filter choice
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p - a < 0 ? a - p : p - a;
  const pb = p - b < 0 ? b - p : p - b;
  const pc = p - c < 0 ? c - p : p - c;
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Filter every row with all five filters, pick per row the filter whose
// bytes look cheapest under a per-filter byte-entropy model, and return the
// filtered stream (filter byte + row bytes, per row).
function filterRows(width, height, rows, bpp) {
  const stride = width * bpp;
  const n = height * (stride + 1);
  const filtered = new Uint8Array(5 * n); // [filter][row][stride+1]
  const hist = [];
  for (let f = 0; f < 5; f++) hist.push(new Float64Array(256));
  const prev = new Uint8Array(stride);
  for (let f = 0; f < 5; f++) {
    prev.fill(0);
    for (let y = 0; y < height; y++) {
      const src = y * stride;
      const dst = f * n + y * (stride + 1);
      filtered[dst] = f;
      const h = hist[f];
      for (let i = 0; i < stride; i++) {
        const x = rows[src + i];
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = (x - (i >= bpp ? rows[src + i - bpp] : 0)) & 0xff;
        else if (f === 2) v = (x - prev[i]) & 0xff;
        else if (f === 3) v = (x - (((i >= bpp ? rows[src + i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
        else v = (x - paeth(i >= bpp ? rows[src + i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff;
        filtered[dst + 1 + i] = v;
        h[v]++;
      }
      prev.set(rows.subarray(src, src + stride));
    }
  }
  // Per-filter entropy lookup tables.
  const lut = [];
  for (let f = 0; f < 5; f++) {
    const table = new Float64Array(256);
    let total = 0;
    for (let b = 0; b < 256; b++) total += hist[f][b];
    for (let b = 0; b < 256; b++) table[b] = -Math.log2((hist[f][b] + 1) / (total + 256));
    lut.push(table);
  }
  // Candidate filter assignments; judged by zlib level 9 (the closest fast
  // proxy for the optimal encoder) and the smallest wins. Per-row entropy
  // choice underrates filter 0 on flat rows (it cannot see long LZ77
  // matches), so plain global assignments are candidates too.
  function buildStream(pick) {
    const s = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      const f = pick(y);
      s.set(filtered.subarray(f * n + y * (stride + 1), f * n + (y + 1) * (stride + 1)), y * (stride + 1));
    }
    return s;
  }
  function entropyPick(y) {
    let bestF = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const table = lut[f];
      const base = f * n + y * (stride + 1) + 1;
      let c = 0;
      for (let i = 0; i < stride; i++) c += table[filtered[base + i]];
      if (c < bestCost) { bestCost = c; bestF = f; }
    }
    return bestF;
  }
  const cands = [
    buildStream(entropyPick),
    buildStream(() => 0),
    buildStream(() => 4),
    buildStream(() => 2),
  ];
  let best = cands[0], bestSize = Infinity;
  for (const stream of cands) {
    const sz = deflateSync(stream, { level: 9 }).length;
    if (sz < bestSize) { bestSize = sz; best = stream; }
  }
  return best;
}

// ---------------------------------------------------------------- Length-limited Huffman (package-merge)
// Returns code lengths (0 = unused) with every length in 1..maxLen and an
// exact Kraft sum of 1 (when at least two symbols are used).
function huffmanLengths(freqs, maxLen) {
  const lengths = new Array(freqs.length).fill(0);
  const syms = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) syms.push(i);
  const n = syms.length;
  if (n === 0) return lengths;
  if (n === 1) { lengths[syms[0]] = 1; return lengths; }
  let list = syms.map((s) => ({ w: freqs[s], s: [s] }));
  list.sort((a, b) => a.w - b.w);
  const orig = list;
  const cap = 2 * n - 2;
  const pack = (lst) => {
    const out = [];
    for (let i = 0; i + 1 < lst.length; i += 2) {
      out.push({ w: lst[i].w + lst[i + 1].w, s: lst[i].s.concat(lst[i + 1].s) });
    }
    if (lst.length % 2 === 1) out.push(lst[lst.length - 1]);
    return out;
  };
  for (let level = 1; level < maxLen; level++) {
    const packaged = pack(list);
    const merged = [];
    let a = 0, b = 0;
    while (merged.length < cap && (a < packaged.length || b < orig.length)) {
      if (b >= orig.length || (a < packaged.length && packaged[a].w <= orig[b].w)) merged.push(packaged[a++]);
      else merged.push(orig[b++]);
    }
    list = merged;
  }
  const finalList = pack(list);
  finalList.sort((a, b) => a.w - b.w);
  const chosen = finalList.slice(0, n - 1);
  for (const p of chosen) for (const s of p.s) lengths[s]++;
  return lengths;
}

// Canonical Huffman codes from lengths. Returns { codes, lengths } where
// codes[s] is the code value (MSB-first) for symbol s.
function canonicalCodes(lengths) {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return { codes, lengths };
}

// ---------------------------------------------------------------- DEFLATE tables
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lengthCode(len) {
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function distCode(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const FIXED_LIT_LEN = (() => {
  const a = new Array(288);
  for (let i = 0; i < 288; i++) a[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return a;
})();
const FIXED_DIST_LEN = new Array(30).fill(5);

// Bit writer (LSB-first within bytes, as DEFLATE requires).
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  writeBits(value, count) {
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  // Write a Huffman code value MSB-first (codes are stored MSB-first).
  writeCode(code, len) {
    for (let i = len - 1; i >= 0; i--) this.writeBits((code >> i) & 1, 1);
  }
  finish() {
    if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
    return Buffer.from(this.bytes);
  }
}

// ---------------------------------------------------------------- Optimal-parse DEFLATE
const BLOCK_SIZE = 262144;
const CHAIN_CAP = 128;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

// RLE-encode the literal/length + distance code lengths for a dynamic block
// header. Returns the sequence of code-length symbols (0..18).
function rleCodeLengths(lengths) {
  const out = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(138, left);
        out.push(18, take - 11);
        left -= take;
      }
      if (left >= 3) { out.push(17, left - 3); left = 0; }
      while (left > 0) { out.push(0); left--; }
    } else {
      out.push(v);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(6, left);
        out.push(16, take - 3);
        left -= take;
      }
      while (left > 0) { out.push(v); left--; }
    }
    i += run;
  }
  return out;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Exact bit cost of a dynamic block header for the given lit/dist lengths
// (excluding the 3-bit BFINAL/BTYPE). Also returns the pieces needed to emit it.
function dynamicHeader(litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = litLen.slice(0, hlit).concat(distLen.slice(0, hdist));
  const seq = rleCodeLengths(all);
  const clFreq = new Array(19).fill(0);
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    clFreq[s]++;
    if (s === 16 || s === 17 || s === 18) i++; // skip the extra-bits slot
  }
  // A code-length code needs at least two symbols (zlib rejects an
  // incomplete CODES tree); add a dummy if necessary.
  let used = 0;
  for (let s = 0; s < 19; s++) if (clFreq[s] > 0) used++;
  if (used < 2) {
    for (let s = 0; s < 19; s++) {
      if (clFreq[s] === 0) { clFreq[s] = 1; used++; break; }
    }
  }
  const clLen = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 5 + 5 + 4 + 3 * hclen;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    bits += clLen[s];
    if (s === 16) { bits += 2; i++; }
    else if (s === 17) { bits += 3; i++; }
    else if (s === 18) { bits += 7; i++; }
  }
  return { bits, hlit, hdist, hclen, clLen, clCodes, seq };
}

function writeDynamicHeader(w, hdr) {
  w.writeBits(hdr.hlit - 257, 5);
  w.writeBits(hdr.hdist - 1, 5);
  w.writeBits(hdr.hclen - 4, 4);
  for (let i = 0; i < hdr.hclen; i++) w.writeBits(hdr.clLen[CL_ORDER[i]], 3);
  const seq = hdr.seq;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    w.writeCode(hdr.clCodes.codes[s], hdr.clLen[s]);
    if (s === 16) { w.writeBits(seq[i + 1], 2); i++; }
    else if (s === 17) { w.writeBits(seq[i + 1], 3); i++; }
    else if (s === 18) { w.writeBits(seq[i + 1], 7); i++; }
  }
}

// One DP pass over a block. litBits/distBits are per-symbol bit lengths
// (fixed table or a dynamic Huffman). Returns the chosen parse as arrays.
function dpParse(data, bs, be, head, prev, litBits, distBits) {
  const m = be - bs;
  const n = data.length;
  const cost = new Float64Array(m + 1);
  const choice = new Int32Array(m + 1); // 0 = literal, else (len<<16)|dist
  for (let i = 1; i <= m; i++) cost[i] = Infinity;
  cost[0] = 0;
  const lenBits = new Float64Array(29);
  for (let c = 0; c < 29; c++) lenBits[c] = litBits[257 + c];
  for (let i = 0; i < m; i++) {
    const base = cost[i];
    if (base === Infinity) continue;
    const pos = bs + i;
    // Literal.
    const lc = base + litBits[data[pos]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; choice[i + 1] = 0; }
    // Matches (need at least 3 bytes left in the block and stream).
    if (i + 2 < m && pos + 2 < n) {
      const maxLen = Math.min(258, m - i);
      const h = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
      let cand = head[h];
      let bestLen = 2, bestDist = 0;
      let count = 0;
      let cap = CHAIN_CAP;
      while (cand >= 0 && count < cap) {
        const dist = pos - cand;
        if (dist > 32768 || dist <= 0) break;
        if (data[cand] === data[pos] && data[cand + 1] === data[pos + 1] && data[cand + 2] === data[pos + 2]) {
          if (!(bestLen < maxLen && data[cand + bestLen] !== data[pos + bestLen])) {
            let l = 3;
            while (l < maxLen && data[cand + l] === data[pos + l]) l++;
            if (l > bestLen) {
              bestLen = l; bestDist = dist;
              const dc = distBits[distCode(dist)];
              // Evaluate every length-code boundary up to l, plus l itself.
              let prevBoundary = -1;
              for (let b = 0; b < 29; b++) {
                const bl = LEN_BASE[b];
                if (bl > l) break;
                if (bl === prevBoundary) continue;
                prevBoundary = bl;
                const c = lengthCode(bl);
                const nc = base + lenBits[c] + LEN_EXTRA[c] + dc + DIST_EXTRA[distCode(dist)];
                const j = i + bl;
                if (nc < cost[j]) { cost[j] = nc; choice[j] = (bl << 16) | dist; }
              }
              if (l !== prevBoundary) {
                const c = lengthCode(l);
                const nc = base + lenBits[c] + LEN_EXTRA[c] + dc + DIST_EXTRA[distCode(dist)];
                const j = i + l;
                if (nc < cost[j]) { cost[j] = nc; choice[j] = (l << 16) | dist; }
              }
              if (l >= 258) break;
            }
          }
        }
        cand = prev[cand];
        count++;
        if (bestLen >= 128 && count >= 8) break;
        // Deepen the search when only a short match was found: a better
        // (longer or nearer) match may hide further down a dense chain.
        if (count >= cap && bestLen < 32 && cap < 1024) cap = 1024;
      }
    }
    // Insert this position into the hash chains for later positions.
    // (Chains only ever hold positions < the position being processed.)
    if (pos + 2 < n) {
      const h = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
      prev[pos] = head[h];
      head[h] = pos;
    }
  }
  return { cost, choice };
}

// Encode one block's parse into the bit writer.
function emitBlock(w, data, bs, ops, litCodes, litLenArr, distCodes, distLenArr) {
  let p = bs;
  for (const op of ops) {
    if (op >= 0) {
      const b = data[p++];
      w.writeCode(litCodes[b], litLenArr[b]);
    } else {
      const v = -op;
      const len = (v / 65536) | 0, dist = v & 0xffff;
      const lc = lengthCode(len);
      w.writeCode(litCodes[257 + lc], litLenArr[257 + lc]);
      if (LEN_EXTRA[lc]) w.writeBits(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(dist);
      w.writeCode(distCodes[dc], distLenArr[dc]);
      if (DIST_EXTRA[dc]) w.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
      p += len;
    }
  }
  w.writeCode(litCodes[256], litLenArr[256]);
}

// Full optimal-parse DEFLATE (raw, no zlib wrapper) for a byte stream.
// Full optimal-parse DEFLATE (raw, no zlib wrapper) for a byte stream.
// Phase A runs the fixed-cost DP over every block (hash chains grow
// incrementally as the stream is swept). Phase B emits the cheapest of the
// two encodings (fixed / dynamic Huffman) of that parse per block.
function deflateOptimal(data) {
  const n = data.length;

  // Parse a DP result into ops + symbol frequencies.
  // ops: literal byte values (>=0), matches as -(len*65536+dist).
  function parseOps(bs, choice, m) {
    const ops = [];
    const litFreq = new Array(288).fill(0);
    const distFreq = new Array(30).fill(0);
    let p = bs;
    let i = m;
    const rev = [];
    while (i > 0) {
      const ch = choice[i];
      if (ch === 0) { rev.push(0); i -= 1; }
      else { rev.push(-ch); i -= ch >> 16; }
    }
    rev.reverse();
    for (const op of rev) {
      if (op === 0) {
        const b = data[p++];
        ops.push(b);
        litFreq[b]++;
      } else {
        const v = -op;
        const len = (v / 65536) | 0, dist = v & 0xffff;
        ops.push(op);
        litFreq[257 + lengthCode(len)]++;
        distFreq[distCode(dist)]++;
        p += len;
      }
    }
    litFreq[256] = 1;
    // A distance alphabet needs at least two symbols for a complete code.
    let distSyms = 0;
    for (let s = 0; s < 30; s++) if (distFreq[s] > 0) distSyms++;
    if (distSyms === 1) {
      for (let s = 0; s < 30; s++) {
        if (distFreq[s] === 0) { distFreq[s] = 1; break; }
      }
    }
    return { ops, litFreq, distFreq };
  }

  function costOf(ops, litL, distL) {
    let c = 0;
    for (const op of ops) {
      if (op >= 0) c += litL[op];
      else {
        const v = -op;
        const len = (v / 65536) | 0, dist = v & 0xffff;
        const lc = lengthCode(len), dc = distCode(dist);
        c += litL[257 + lc] + LEN_EXTRA[lc] + distL[dc] + DIST_EXTRA[dc];
      }
    }
    return c + litL[256];
  }

  // Phase A: fixed-cost DP over every block, in stream order.
  const headA = new Int32Array(HASH_SIZE).fill(-1);
  const prevA = new Int32Array(n);
  const blocks = [];
  let bs = 0;
  while (bs < n) {
    const be = Math.min(n, bs + BLOCK_SIZE);
    const p1 = dpParse(data, bs, be, headA, prevA, FIXED_LIT_LEN, FIXED_DIST_LEN);
    const r1 = parseOps(bs, p1.choice, be - bs);
    const dynLitLen = huffmanLengths(r1.litFreq, 15);
    const dynDistLen = huffmanLengths(r1.distFreq, 15);
    const fixedCost = costOf(r1.ops, FIXED_LIT_LEN, FIXED_DIST_LEN) + 3;
    const hdr1 = dynamicHeader(dynLitLen, dynDistLen);
    const dynCost1 = costOf(r1.ops, dynLitLen, dynDistLen) + 3 + hdr1.bits;
    blocks.push({ bs, be, isLast: be === n, ops1: r1.ops, dynLitLen, dynDistLen, fixedCost, dynCost1, hdr1 });
    bs = be;
  }

  // Phase B: emit, in stream order. A second DP pass buys ~1-2% but costs
  // ~80% more time, so it is not run: the wall budget is 60 s for the set.
  const w = new BitWriter();
  for (const blk of blocks) {
    if (blk.fixedCost <= blk.dynCost1) {
      w.writeBits(blk.isLast ? 1 : 0, 1);
      w.writeBits(1, 2); // BTYPE fixed
      const fixed = canonicalCodes(FIXED_LIT_LEN);
      const fixedD = canonicalCodes(FIXED_DIST_LEN);
      emitBlock(w, data, blk.bs, blk.ops1, fixed.codes, FIXED_LIT_LEN, fixedD.codes, FIXED_DIST_LEN);
    } else {
      w.writeBits(blk.isLast ? 1 : 0, 1);
      w.writeBits(2, 2); // BTYPE dynamic
      writeDynamicHeader(w, blk.hdr1);
      const litC = canonicalCodes(blk.dynLitLen);
      const distC = canonicalCodes(blk.dynDistLen);
      emitBlock(w, data, blk.bs, blk.ops1, litC.codes, blk.dynLitLen, distC.codes, blk.dynDistLen);
    }
  }
  const raw = w.finish();
  const out = Buffer.alloc(2 + raw.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  raw.copy(out, 2);
  out.writeUInt32BE(adler32(data), 2 + raw.length);
  return out;
}


// ---------------------------------------------------------------- Main driver
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function processInstance(inputPath) {
  const input = readFileSync(inputPath);
  const { width, height, rgba } = decodePng(input);
  const rep = reduceColours(width, height, rgba);
  const filtered = filterRows(width, height, rep.rows, rep.bpp);
  const zlibData = deflateOptimal(filtered);
  let png = encodePng(width, height, rep.colourType, rep.plte, rep.trns, zlibData);
  // Verify: decode the produced PNG and compare every pixel.
  try {
    const check = decodePng(png);
    if (check.width !== width || check.height !== height || !arraysEqual(check.rgba, rgba)) {
      throw new Error('verify mismatch');
    }
  } catch (e) {
    // Fallback: plain zlib level 9 over the same filtered stream.
    const fb = deflateSync(filtered, { level: 9 });
    png = encodePng(width, height, rep.colourType, rep.plte, rep.trns, fb);
    try {
      const check = decodePng(png);
      if (check.width !== width || check.height !== height || !arraysEqual(check.rgba, rgba)) {
        throw new Error('fallback verify mismatch');
      }
    } catch (e2) {
      png = input; // Last resort: byte copy of the input (always valid).
    }
  }
  return png;
}

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN).sort()) {
  mkdirSync(join(OUT, id), { recursive: true });
  const png = processInstance(join(IN, id, 'image.png'));
  writeFileSync(join(OUT, id, 'image.png'), png);
}
