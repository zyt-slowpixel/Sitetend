"""Builds ui/locales/zh-Hant.json from zh-Hans.json: Taiwan terminology first, then character conversion.
Run: python tools/i18n/make_zh_hant.py   (then read the output once; overrides below win)"""
import json, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
MAP = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'zh_hant_map.json'), encoding='utf-8'))
PHRASES = [tuple(x) for x in MAP['phrases']]
CHARS = dict(zip(MAP['chars'], MAP['charsTo']))
OVERRIDES = MAP['overrides']
src = json.load(open(os.path.join(ROOT, 'ui/locales/zh-Hans.json'), encoding='utf-8'))
out = {}
for k, v in src.items():
    for a, b in PHRASES: v = v.replace(a, b)
    out[k] = OVERRIDES.get(k, ''.join(CHARS.get(c, c) for c in v))
json.dump(out, open(os.path.join(ROOT, 'ui/locales/zh-Hant.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
open(os.path.join(ROOT, 'ui/locales/zh-Hant.json'), 'a').write('\n')
print(len(out), 'keys')
