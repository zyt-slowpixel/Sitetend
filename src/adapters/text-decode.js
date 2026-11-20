import { LEXICON } from '../host/lexicon.mjs';
// Materials are only read, never written, so a file saved in an older encoding can be decoded by guessing:
// UTF-8 first; otherwise the common Chinese and Japanese encodings, keeping the one whose result has the most
// everyday characters (any of them turns random bytes into rare characters); otherwise Western (Windows-1252).
const tryDecode = (enc, bytes) => { try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { return null; } };
// Frequent characters in Chinese (simplified and traditional) and Japanese; hiragana and katakana count too.
const COMMON = new Set([...(LEXICON.commonCjkCharacters || '')]);
const KANA = /[぀-ヿ]/;
const score = text => { let wide = 0, good = 0; for (const c of text) { if (c.charCodeAt(0) < 128) continue; wide++; if (COMMON.has(c) || KANA.test(c) || /[\u3000-\u303f\uff00-\uffef]/.test(c)) good++; } return wide ? good / wide : 0; };
export function decodeText(bytes) {
  const utf8 = tryDecode('utf-8', bytes); if (utf8 != null) return { text: utf8, encoding: 'utf-8' };
  const best = ['gb18030', 'big5', 'shift_jis', 'euc-kr'].map(enc => ({ enc, text: tryDecode(enc, bytes) })).filter(x => x.text != null)
    .map(x => ({ ...x, s: score(x.text) })).sort((a, b) => b.s - a.s)[0];
  if (best && best.s >= 0.25) return { text: best.text, encoding: best.enc };
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
}
