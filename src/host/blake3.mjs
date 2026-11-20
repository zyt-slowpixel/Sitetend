// @ts-check
// BLAKE3 hash (default mode, 32-byte output), written from the specification.
// Cloudflare Pages names each uploaded file by a BLAKE3 hash, and Node does not include BLAKE3.
// Checked against the official test vectors in tests/blake3.mjs.

const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1, CHUNK_END = 2, PARENT = 4, ROOT = 8;
const BLOCK = 64, CHUNK = 1024;

// Message word order for each of the 7 rounds (the permutation applied 0..6 times).
const SCHEDULE = (() => {
  const out = []; let m = [...Array(16).keys()];
  for (let r = 0; r < 7; r++) { out.push(m); m = PERM.map(i => m[i]); }
  return out;
})();

const s = new Uint32Array(16);
/** Compresses one block. Writes the first 8 output words into `out` (the next chaining value). */
function compress(cv, m, counter, len, flags, out) {
  s[0] = cv[0]; s[1] = cv[1]; s[2] = cv[2]; s[3] = cv[3]; s[4] = cv[4]; s[5] = cv[5]; s[6] = cv[6]; s[7] = cv[7];
  s[8] = IV[0]; s[9] = IV[1]; s[10] = IV[2]; s[11] = IV[3];
  s[12] = counter >>> 0; s[13] = Math.floor(counter / 0x100000000) >>> 0; s[14] = len; s[15] = flags;
  for (let r = 0; r < 7; r++) {
    const o = SCHEDULE[r];
    g(0, 4, 8, 12, m[o[0]], m[o[1]]); g(1, 5, 9, 13, m[o[2]], m[o[3]]);
    g(2, 6, 10, 14, m[o[4]], m[o[5]]); g(3, 7, 11, 15, m[o[6]], m[o[7]]);
    g(0, 5, 10, 15, m[o[8]], m[o[9]]); g(1, 6, 11, 12, m[o[10]], m[o[11]]);
    g(2, 7, 8, 13, m[o[12]], m[o[13]]); g(3, 4, 9, 14, m[o[14]], m[o[15]]);
  }
  for (let i = 0; i < 8; i++) out[i] = s[i] ^ s[i + 8];
}
function g(a, b, c, d, x, y) {
  s[a] = (s[a] + s[b] + x) >>> 0; s[d] ^= s[a]; s[d] = (s[d] >>> 16) | (s[d] << 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = (s[b] >>> 12) | (s[b] << 20);
  s[a] = (s[a] + s[b] + y) >>> 0; s[d] ^= s[a]; s[d] = (s[d] >>> 8) | (s[d] << 24);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = (s[b] >>> 7) | (s[b] << 25);
}

const words = new Uint32Array(16);
/** Loads up to 64 bytes from `bytes` at `at` as little-endian words (zero padded). */
function load(bytes, at, len) {
  words.fill(0);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[at + i] << ((i & 3) * 8);
}

/** BLAKE3 of `data` (Buffer, Uint8Array or string as UTF-8), as 64 hex characters. */
export function blake3(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const n = bytes.length;
  const chunks = Math.max(1, Math.ceil(n / CHUNK));
  const stack = [];   // chaining values of finished subtrees
  const cv = new Uint32Array(8);
  let last = null;    // the final chunk's last block, compressed at the end (it may be the root)
  for (let c = 0; c < chunks; c++) {
    cv.set(IV);
    const start = c * CHUNK, end = Math.min(n, start + CHUNK);
    const blocks = Math.max(1, Math.ceil((end - start) / BLOCK));
    for (let b = 0; b < blocks; b++) {
      const at = start + b * BLOCK, len = Math.min(BLOCK, end - at);
      load(bytes, at, Math.max(0, len));
      let flags = (b === 0 ? CHUNK_START : 0) | (b === blocks - 1 ? CHUNK_END : 0);
      if (c === chunks - 1 && b === blocks - 1) { last = { cv: Uint32Array.from(cv), m: Uint32Array.from(words), counter: c, len: Math.max(0, len), flags }; break; }
      compress(cv, words, c, len, flags, cv);
    }
    if (c === chunks - 1) break;
    // Merge finished subtrees: after chunk c, merge once for each trailing zero bit of the chunk count.
    let node = Uint32Array.from(cv), total = c + 1;
    while ((total & 1) === 0) { node = parent(stack.pop(), node); total >>= 1; }
    stack.push(node);
  }
  // Fold the stack into the final output, right to left.
  let out = last;
  while (stack.length) {
    const right = new Uint32Array(8); compress(out.cv, out.m, out.counter, out.len, out.flags, right);
    const m = new Uint32Array(16); m.set(stack.pop(), 0); m.set(right, 8);
    out = { cv: IV, m, counter: 0, len: BLOCK, flags: PARENT };
  }
  const h = new Uint32Array(8); compress(out.cv, out.m, 0, out.len, out.flags | ROOT, h);
  const outBytes = Buffer.alloc(32); for (let i = 0; i < 8; i++) outBytes.writeUInt32LE(h[i], i * 4);
  return outBytes.toString('hex');
}
function parent(left, right) {
  const m = new Uint32Array(16); m.set(left, 0); m.set(right, 8);
  const out = new Uint32Array(8); compress(IV, m, 0, BLOCK, PARENT, out); return out;
}
