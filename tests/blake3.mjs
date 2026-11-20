// BLAKE3 against the official test vectors (github.com/BLAKE3-team/BLAKE3, test_vectors/test_vectors.json).
import fs from 'node:fs';
import { blake3 } from '../src/host/blake3.mjs';
const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/blake3-vectors.json', import.meta.url), 'utf8'));
let pass = 0;
for (const c of cases) {
  const input = Buffer.alloc(c.input_len); for (let i = 0; i < c.input_len; i++) input[i] = i % 251;
  const got = blake3(input), want = c.hash.slice(0, 64);
  if (got !== want) { console.error(`✗ length ${c.input_len}: ${got} (expected ${want})`); process.exit(1); }
  pass++;
}
console.log(`${pass} BLAKE3 checks passed`);
