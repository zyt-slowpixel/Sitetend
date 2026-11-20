"""
Held-out set for website projects built with a JavaScript framework (written 2026-11-12, BEFORE any model ran on it;
report only, never used for tuning).

  ext3-astro-devportfolio     Astro      (open source, MIT)  words in src/config.ts and .astro components
  ext3-react-masterportfolio  React/CRA  (open source, MIT)  words in src/portfolio.js and .js components
  ext3-next-tailwindblog      Next.js    (open source, MIT)  words in data/siteMetadata.js, data/authors/*.mdx, app/*.tsx
  own-vue-studio              Vue + Vite (written here)      words in .vue templates and <script setup>
  own-svelte-band             SvelteKit  (written here)      words in src/lib/shows.js and +page.svelte
Each site gets a materials file that matches its sample content; every case changes that file in one way.
Run: python eval/fixtures/build_ext3.py
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

# ---------------------------------------------------------------- Astro: devportfolio
w = setup('ext3-astro-devportfolio', 'resume.md', """# Ryan Fitzgerald - resume notes

Email: your-email@example.com
Current job: Senior Software Engineer at Tech Company (Jan 2022 - Present)
- Led development of microservices architecture serving 1M+ users
- Mentored team of 5 junior developers
""")
case('ext3-astro-devportfolio', 'Framework · Astro: contact email', 'f-update', {'contains': {'~your-email@example.com': ['ryan@fitz.example']}},
     w('Email: your-email@example.com', 'Email: ryan@fitz.example'))
case('ext3-astro-devportfolio', 'Framework · Astro: leading a bigger team', 'f-update', {'contains': {'~Mentored team of 5': ['8']}},
     w('Mentored team of 5 junior developers', 'Mentored team of 8 junior developers'))
case('ext3-astro-devportfolio', 'Framework · Astro: new job not started yet', 'f-trap', {'forbid': ['~Tech Company'], 'forbidText': ['Nimbus']},
     w(add='\nPlanned (not announced): joining Nimbus Labs as Staff Engineer next spring.\n'))
case('ext3-astro-devportfolio', 'Framework · Astro: private reminder', 'f-ignore', {'noProposals': True}, w(add='\nReminder: renew passport before June.\n'))

# ---------------------------------------------------------------- React (Create React App): masterPortfolio
w = setup('ext3-react-masterportfolio', 'work.md', """# Ashutosh Hathidara - work history

- Machine Learning Engineer, TikTok Inc., San Jose, CA, USA (June 2023 - Present)
- Associate AI Engineer, Legato Health Technology, Hyderabad, Telangana (June 2020 - Aug 2021)

Education: Indiana University Bloomington, M.S. in Computer Science (2021 - 2023)
""")
case('ext3-react-masterportfolio', 'Framework · React: promotion', 'f-update', {'contains': {'~Machine Learning Engineer': ['Senior']}, 'onlyFields': ['~Machine Learning Engineer']},
     w('- Machine Learning Engineer, TikTok Inc.', '- Senior Machine Learning Engineer, TikTok Inc.'))
case('ext3-react-masterportfolio', 'Framework · React: work location', 'f-update', {'contains': {'~San Jose, CA, USA': ['Seattle']}},
     w('TikTok Inc., San Jose, CA, USA', 'TikTok Inc., Seattle, WA, USA'))
case('ext3-react-masterportfolio', "Framework · React: a colleague's news", 'f-trap', {'forbidText': ['Priya']},
     w(add='\nTeam news: my colleague Priya Shah was promoted to Staff Engineer.\n'))
case('ext3-react-masterportfolio', 'Framework · React: to-do', 'f-ignore', {'noProposals': True}, w(add='\nTODO: update the GitHub token for the open source page.\n'))

# ---------------------------------------------------------------- Next.js: tailwind-nextjs-starter-blog
w = setup('ext3-next-tailwindblog', 'author.md', """# Tails Azimuth (author profile)

Occupation: Professor of Atmospheric Science
Company: Stanford University
Blog description: A blog created with Next.js and Tailwind.css
""")
case('ext3-next-tailwindblog', 'Framework · Next.js: new employer', 'f-update', {'contains': {'~Stanford University': ['Northfield University']}},
     w('Company: Stanford University', 'Company: Northfield University'))
case('ext3-next-tailwindblog', 'Framework · Next.js: blog description', 'f-update', {'contains': {'~A blog created with Next.js': ['weather']}},
     w('Blog description: A blog created with Next.js and Tailwind.css', 'Blog description: A weather blog created with Next.js and Tailwind.css'))
case('ext3-next-tailwindblog', "Framework · Next.js: someone else's job title", 'f-trap', {'forbidText': ['Dean']},
     w(add='\nCampus news: Professor Lee became Dean of Engineering.\n'))
case('ext3-next-tailwindblog', 'Framework · Next.js: meeting schedule', 'f-ignore', {'noProposals': True}, w(add='\nLab meeting moved to Thursday 3 pm.\n'))

# ---------------------------------------------------------------- Vue + Vite (own)
w = setup('own-vue-studio', 'studio-notes.md', """# Mira Okafor - studio notes

Tagline: Picture books, posters and editorial illustration
Books illustrated: 6
City: Columbus, Ohio
Email: hello@mirastudio.example
""")
case('own-vue-studio', 'Framework · Vue: another book published', 'f-update', {'contains': {'~illustrated 6 picture books': ['7']}},
     w('Books illustrated: 6', 'Books illustrated: 7'))
case('own-vue-studio', 'Framework · Vue: moved', 'f-update', {'contains': {'~Columbus, Ohio': ['Cincinnati']}},
     w('City: Columbus, Ohio', 'City: Cincinnati, Ohio'))
case('own-vue-studio', "Framework · Vue: a client's email", 'f-trap', {'forbid': ['~hello@mirastudio.example'], 'forbidText': ['art@client']},
     w(add='\nClient contact for the poster job: art@client.example\n'))
case('own-vue-studio', 'Framework · Vue: shopping list', 'f-ignore', {'noProposals': True}, w(add='\nBuy: brushes, ink, A3 paper.\n'))

# ---------------------------------------------------------------- SvelteKit (own)
w = setup('own-svelte-band', 'band-notes.md', """# The Low Tides - band notes

Bio: Four friends from Ypsilanti playing surf rock with too much reverb.
Booking: booking@lowtides.example
New album: Saltwater Static, out on vinyl this winter.
Shows: Dec 6 The Blind Pig, Ann Arbor, MI; Dec 13 Pike Room, Pontiac, MI
""")
case('own-svelte-band', 'Framework · Svelte: booking email', 'f-update', {'contains': {'~booking@lowtides.example': ['shows@lowtides.example']}},
     w('Booking: booking@lowtides.example', 'Booking: shows@lowtides.example'))
case('own-svelte-band', 'Framework · Svelte: show moved to another venue', 'f-update', {'contains': {'~Pike Room': ['Magic Stick']}},
     w('Dec 13 Pike Room, Pontiac, MI', 'Dec 13 Magic Stick, Detroit, MI'))
case('own-svelte-band', 'Framework · Svelte: another band', 'f-trap', {'forbidText': ['Velvet Static']},
     w(add='\nWe open for Velvet Static in January (their show, not ours to list).\n'))
case('own-svelte-band', 'Framework · Svelte: rehearsal times', 'f-ignore', {'noProposals': True}, w(add='\nRehearsal: Tuesdays 7 pm at Sam\'s garage.\n'))

json.dump({'version': 1, 'heldOut': True, 'note': 'Framework projects (Astro, React, Next.js, Vue, Svelte). Written before any model run; report only.', 'cases': CASES},
          open(os.path.join(ROOT, 'eval', 'cases-ext3.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(CASES), 'cases on', len({c['site'] for c in CASES}), 'sites')
