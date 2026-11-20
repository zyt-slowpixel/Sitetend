// Named HTML entities that appear in hand-written pages: punctuation, arrows, symbols and accented letters.
// Names are case-sensitive (&Eacute; is É, &eacute; is é); an unknown name is left as it is.
const LETTERS = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', thorn: 'þ', szlig: 'ß', oelig: 'œ', scaron: 'š', zcaron: 'ž',
};
export const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§', middot: '·', bull: '•',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', sup1: '¹', sup2: '²', sup3: '³',
  frac14: '¼', frac12: '½', frac34: '¾', cent: '¢', pound: '£', yen: '¥', euro: '€', curren: '¤', brvbar: '¦', not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', crarr: '↵', lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔',
  hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', star: '☆', starf: '★', check: '✓', cross: '✗', loz: '◊', infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', minus: '−',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω',
  ...LETTERS, ...Object.fromEntries(Object.entries(LETTERS).filter(([k]) => k !== 'szlig').map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v.toUpperCase()])),
};
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m);
