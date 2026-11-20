// Small Markdown renderer for previewing a README (a GitHub profile page) without the network.
// Covers what profile READMEs use: headings, paragraphs, lists, quotes, code, tables, rules, links, images,
// bold / italic / code spans and inline HTML (GitHub allows <p align>, <img>, <br>, <details>…).
// Scripts are removed later by the preview, which also runs in a sandbox.

const esc = s => s.replace(/&(?![#\w]+;)/g, '&amp;').replace(/<(?![a-zA-Z/!])/g, '&lt;');

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i].replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code>');
}

export function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n'), out = [];
  let i = 0;
  const isBlank = l => !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = line.match(/^\s*(```|~~~)/))) {                                   // fenced code
      const fence = m[1], body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++; out.push('<pre><code>' + body.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></pre>'); continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*</.test(line)) {                                                  // HTML block: as written, up to a blank line
      const body = []; while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      out.push(body.join('\n')); continue;
    }
    if (/^\s*>/.test(line)) {
      const body = []; while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>'); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {   // table
      const row = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = row(line); i += 2; const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(row(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+/))) {                          // list (one level is enough for a profile)
      const ordered = /\d/.test(m[1]), items = [];
      while (i < lines.length && (m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        let item = m[2].replace(/^\[([ xX])\]\s+/, (_, x) => x.trim() ? '☑ ' : '☐ '); i++;
        while (i < lines.length && !isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push('<li>' + inline(item) + '</li>');
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>')); continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|\s*(```|~~~|>|<)|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) {
      if (para.length && /^(=+|-+)\s*$/.test(lines[i])) { out.push(`<h${lines[i][0] === '=' ? 1 : 2}>${inline(para.join(' '))}</h${lines[i][0] === '=' ? 1 : 2}>`); para.length = 0; i++; break; }
      para.push(lines[i++].trim());
    }
    if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  return out.join('\n');
}

/** The words of a Markdown snippet as a reader sees them (no link targets, emphasis marks or tags). */
export function plainMarkdown(s) {
  return String(s ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '').replace(/(\*\*|__|~~|`)/g, '').replace(/(^|[^\w])[*_](?=\S)([^*_]*?\S)[*_](?!\w)/g, '$1$2');
}

/** GitHub-like look for the README preview. */
export const README_CSS = 'body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328;background:#fff;margin:0}' +
  'main{max-width:840px;margin:32px auto;padding:32px 40px;border:1px solid #d1d9e0;border-radius:6px}' +
  'h1,h2{padding-bottom:.3em;border-bottom:1px solid #d1d9e0}h1,h2,h3,h4{margin:24px 0 16px;font-weight:600;line-height:1.25}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}' +
  'p,ul,ol,blockquote,table,pre{margin:0 0 16px}a{color:#0969da;text-decoration:none}img{max-width:100%}code{font:85% ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(129,139,152,.12);padding:.2em .4em;border-radius:6px}' +
  'pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}blockquote{color:#59636e;border-left:.25em solid #d1d9e0;padding:0 1em;margin-left:0}' +
  'table{border-collapse:collapse}th,td{border:1px solid #d1d9e0;padding:6px 13px}hr{border:0;height:.25em;background:#d1d9e0;margin:24px 0}ul,ol{padding-left:2em}';
