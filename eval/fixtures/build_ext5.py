"""
Held-out set for Hexo and Eleventy (11ty) sites (written 2026-11-13, BEFORE any model ran on it;
report only, never used for tuning).

  ext5-hexo-starter         Hexo      (open source, MIT)  words in _config.yml and source/_posts/*.md
  ext5-eleventy-baseblog    Eleventy  (open source, MIT)  words in _data/metadata.js, content/*.md, .njk templates
  ext5-eleventy-hpblog      Eleventy  (open source, MIT)  words in _data/metadata.json, about/index.md, .njk templates
  own-hexo-researcher       Hexo      (written here)      _config.yml, source/about/index.md, source/_data/talks.yml
  own-eleventy-designer     Eleventy  (written here)      src/_data/site.json, src/_includes/base.njk, src/work/*.md
Each site gets a materials file that matches its sample content; every case changes that file in one way.
Run: python eval/fixtures/build_ext5.py
"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SITES = os.path.join(ROOT, 'eval', 'sites')

def write(site, rel, content):
    p = os.path.join(SITES, site, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8', newline='\n').write(content)

CASES = []
def case(site, name, cat, expect, writes):
    CASES.append({'name': name, 'category': cat, 'site': 'eval/sites/' + site, 'expect': expect, 'writes': writes})
def setup(site, file, text):
    write(site, 'sources/' + file, text)
    return lambda old=None, new=None, add='': {'sources/' + file: (text.replace(old, new) if old else text) + add}

# ---------------------------------------------------------------- Hexo: starter
w = setup('ext5-hexo-starter', 'me.md', """# About me

Name: John Doe
Site name: Hexo
""")
case('ext5-hexo-starter', 'Hexo · official template: site name', 'g-update', {'contains': {'~Hexo': ['Notes from the Workshop']}, 'onlyFields': ['~Hexo']},
     w('Site name: Hexo', 'Site name: Notes from the Workshop'))
case('ext5-hexo-starter', 'Hexo · official template: author name', 'g-update', {'contains': {'~John Doe': ['Maya Chen']}},
     w('Name: John Doe', 'Name: Maya Chen'))
case('ext5-hexo-starter', "Hexo · official template: a friend's blog", 'g-trap', {'forbidText': ['Riverbank']},
     w(add='\nMy friend just started a blog called Riverbank Notes.\n'))
case('ext5-hexo-starter', 'Hexo · official template: private matter', 'g-ignore', {'noProposals': True}, w(add='\nDentist on Friday at 9.\n'))

# ---------------------------------------------------------------- Eleventy: base blog
w = setup('ext5-eleventy-baseblog', 'profile.md', """# Profile

Name: Your Name Here
Email: youremailaddress@example.com
Blog tagline: I am writing about my experiences as a naval navel-gazer.
About me: I am a person that writes stuff.
""")
case('ext5-eleventy-baseblog', 'Eleventy · official template: name', 'g-update', {'contains': {'~Your Name Here': ['Ana Ruiz']}},
     w('Name: Your Name Here', 'Name: Ana Ruiz'))
case('ext5-eleventy-baseblog', 'Eleventy · official template: email', 'g-update', {'contains': {'~youremailaddress@example.com': ['ana@ruiz.example']}},
     w('Email: youremailaddress@example.com', 'Email: ana@ruiz.example'))
case('ext5-eleventy-baseblog', 'Eleventy · official template: about me', 'g-update', {'contains': {'~I am a person that writes stuff': ['bread']}},
     w('About me: I am a person that writes stuff.', 'About me: I bake bread and write about it.'))
case('ext5-eleventy-baseblog', 'Eleventy · official template: plans not decided yet', 'g-trap', {'forbidText': ['podcast']},
     w(add='\nMaybe I will start a podcast next year, not decided.\n'))

# ---------------------------------------------------------------- Eleventy: high performance blog
w = setup('ext5-eleventy-hpblog', 'site-notes.md', """# Site notes

Site title: Title of the website. Update me.
Site description: Description of the website. Update me.
About: I am a person that writes stuff.
""")
case('ext5-eleventy-hpblog', 'Eleventy · high-performance template: site title', 'g-update', {'contains': {'~Title of the website': ['Quiet Compilers']}},
     w('Site title: Title of the website. Update me.', 'Site title: Quiet Compilers'))
case('ext5-eleventy-hpblog', 'Eleventy · high-performance template: site description', 'g-update', {'contains': {'~Description of the website': ['compiler']}},
     w('Site description: Description of the website. Update me.', 'Site description: Short essays on compilers and fast websites.'))
case('ext5-eleventy-hpblog', "Eleventy · high-performance template: a colleague's book", 'g-trap', {'forbidText': ['Rust in Practice']},
     w(add='\nMy coworker Dev published a book, Rust in Practice.\n'))
case('ext5-eleventy-hpblog', 'Eleventy · high-performance template: to-do', 'g-ignore', {'noProposals': True}, w(add='\nTODO: renew the domain before March.\n'))

# ---------------------------------------------------------------- Hexo (own): researcher
w = setup('own-hexo-researcher', 'cv-notes.md', """# Lena Varga - CV notes

Position: fourth-year PhD candidate, Ecology and Evolutionary Biology, University of Washington
Advisor: Dr. Hannah Ruiz
Email: lena.varga@uw.example.edu
Research: how sea star wasting disease changes rocky shore communities in the Salish Sea
""")
case('own-hexo-researcher', 'Hexo · hand-written: now a fifth-year', 'g-update', {'contains': {'~fourth-year PhD candidate': ['fifth-year']}},
     w('Position: fourth-year PhD candidate', 'Position: fifth-year PhD candidate'))
case('own-hexo-researcher', 'Hexo · hand-written: new email', 'g-update', {'contains': {'~lena.varga@uw.example.edu': ['lvarga@uw.example.edu']}},
     w('Email: lena.varga@uw.example.edu', 'Email: lvarga@uw.example.edu'))
case('own-hexo-researcher', "Hexo · hand-written: the advisor's award", 'g-trap', {'forbidText': ['Sloan']},
     w(add='\nNews: my advisor Dr. Ruiz won a Sloan Fellowship.\n'))
case('own-hexo-researcher', 'Hexo · hand-written: lab chores', 'g-ignore', {'noProposals': True}, w(add='\nLab cleanup on Wednesday, bring gloves.\n'))

# ---------------------------------------------------------------- Eleventy (own): designer
w = setup('own-eleventy-designer', 'portfolio-notes.md', """# Tomás Ito - portfolio notes

Role: Product designer at Northwell Labs (since 2022)
City: Chicago, IL
Status: Currently open to full-time roles in health tech.
Projects:
- Shift Planner (2024): A scheduling tool that cut nurse overtime by 12%.
- Clinic Check-in (2023): A tablet check-in flow used at 40 clinics.
""")
case('own-eleventy-designer', 'Eleventy · hand-written: moved', 'g-update', {'contains': {'~Chicago, IL': ['Denver']}},
     w('City: Chicago, IL', 'City: Denver, CO'))
case('own-eleventy-designer', 'Eleventy · hand-written: found a job', 'g-update', {'fieldsAny': ['~Currently open to full-time roles'], 'forbidText': ['open to full-time']},
     w('Status: Currently open to full-time roles in health tech.', 'Status: Not looking right now; I just joined a new team.'))
case('own-eleventy-designer', 'Eleventy · hand-written: new project', 'g-item', {'newItem': {'collection': 'src/work', 'values': {'title': ['Med Reminder']}}, 'acceptItem': True},
     w(add='- Med Reminder (2025): A medication reminder app for older adults.\n'))
case('own-eleventy-designer', "Eleventy · hand-written: a client's name", 'g-trap', {'forbidText': ['Lakeside']},
     w(add='\nPossible client (not signed, confidential): Lakeside Health.\n'))

json.dump({'version': 1, 'heldOut': True, 'note': 'Hexo and Eleventy sites. Written before any model run; report only.', 'cases': CASES},
          open(os.path.join(ROOT, 'eval', 'cases-ext5.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(CASES), 'cases on', len({c['site'] for c in CASES}), 'sites')
