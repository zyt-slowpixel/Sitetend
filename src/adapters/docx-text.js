// Plain text from a Word (.docx) file, with no extra packages: a .docx is a ZIP archive and the
// text lives in word/document.xml. Paragraphs become lines; formatting, images and tables' layout are dropped.
import zlib from 'node:zlib';

const MAX_XML = 20 * 1024 * 1024;   // stops a "zip bomb" from filling memory

function findEntry(buf, wanted) {
  // End of central directory record: last 22 bytes plus an optional comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('not a Word file (no ZIP directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw Error('damaged Word file');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML });
      throw Error('unsupported compression in Word file');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw Error('no document text found in Word file');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);

/** @param {Uint8Array} bytes the .docx file  @returns {string} its text, one paragraph per line */
export function docxText(bytes) {
  const xml = findEntry(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'word/document.xml').toString('utf8');
  const text = xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)\/>/g, '\n')
    .replace(/<\/w:p>\s*<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text).split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
