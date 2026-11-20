"""
Held-out set for websites the way AI builders and chat assistants make them (written 2026-11-13, BEFORE any model
ran on it; report only, never used for tuning).

  ext7-lovable-glowfolio   Lovable (Vite + React + shadcn)     open source, MIT   words in src/components/*.tsx
  ext7-bolt-personal       bolt.new (Vite + React)             open source, MIT   words in src/pages, src/Home.tsx
  ext7-angular-portfolio   Angular (standalone components)     open source, MIT   *.component.html, src/app/data/*.ts
  ext7-flask-mlh           Flask + Jinja templates             open source, MIT   app/static/user-template.json, templates/
  ext7-sveltekit-slick     SvelteKit + shadcn-svelte           open source, MIT   src/lib/data/*.ts
  ext7-vite-react          Vite + React (one folder down in its repo)  open source, MIT   src/components/*.tsx
  own-php-cafe             PHP pages (arrays + HTML)           written here
  own-chatgpt-single       one HTML file, projects in a <script>  written here
  own-replit-fullstack     React client/ + Express server/     written here
  own-v0-studio            Next.js App Router + shadcn (v0)    written here
Each site gets a materials file that matches its sample content; every case changes that file in one way.
Run: python eval/fixtures/build_ext7.py
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

# ---------------------------------------------------------------- Lovable
w = setup('ext7-lovable-glowfolio', 'me.md', """# Harshit - notes

Job: software developer at C.C.N
Location: Roorkee, India
""")
case('ext7-lovable-glowfolio', 'Lovable: moved', 'g-update', {'contains': {'~Roorkee, India': ['Bengaluru']}},
     w('Location: Roorkee, India', 'Location: Bengaluru, India (moved in 2026)'))
case('ext7-lovable-glowfolio', 'Lovable: new job', 'g-update', {'contains': {'~Currently working at C.C.N': ['Razorpay']}},
     w('Job: software developer at C.C.N', 'Job: software developer at Razorpay (left C.C.N in September 2026)'))
case('ext7-lovable-glowfolio', "Lovable: a friend's project", 'g-trap', {'forbidText': ['TrailMix']},
     w(add='\nMy roommate is building an app called TrailMix.\n'))

# ---------------------------------------------------------------- bolt.new
w = setup('ext7-bolt-personal', 'cv.md', """# Jibanul Haque - CV

Current role: AI Researcher (PhD in Computer Vision)
""")
case('ext7-bolt-personal', 'Bolt: new role', 'g-update', {'contains': {'~Jibanul Haque - AI Researcher': ['Research Scientist']}},
     w('Current role: AI Researcher (PhD in Computer Vision)', 'Current role: Research Scientist at Toyota Research Institute (PhD in Computer Vision)'))
case('ext7-bolt-personal', 'Bolt: review invitation', 'g-trap', {'forbidText': ['CVPR 2027']},
     w(add='\nInvited to review for CVPR 2027 (confidential until the program is out).\n'))
case('ext7-bolt-personal', 'Bolt: private matter', 'g-ignore', {'noProposals': True}, w(add='\nPick up dry cleaning on Friday.\n'))

# ---------------------------------------------------------------- Angular
w = setup('ext7-angular-portfolio', 'profile.md', """# Barbara Calderon - profile

From: Brazil
Languages: Portuguese (native), English (fluent)
""")
case('ext7-angular-portfolio', 'Angular: one more language', 'g-update', {'contains': {'~I am a Software Developer from Brazil': ['German']}},
     w('Languages: Portuguese (native), English (fluent)', 'Languages: Portuguese (native), English (fluent), German (intermediate, since 2026)'))
case('ext7-angular-portfolio', 'Angular: an offer not decided yet', 'g-trap', {'forbidText': ['Nubank']},
     w(add='\nGot to the final round at Nubank, waiting to hear back.\n'))
case('ext7-angular-portfolio', 'Angular: to-do', 'g-ignore', {'noProposals': True}, w(add='\nTODO: renew passport.\n'))

# ---------------------------------------------------------------- Flask
w = setup('ext7-flask-mlh', 'about-me.md', """# About me

Name: John Doe
Hobbies: Reading, Writing, Drawing
""")
case('ext7-flask-mlh', 'Flask: name', 'g-update', {'contains': {'~John Doe': ['Aisha Bello']}},
     w('Name: John Doe', 'Name: Aisha Bello'))
case('ext7-flask-mlh', 'Flask: new hobby', 'g-update', {'fieldsAny': ['~Drawing'], 'contains': {'~Drawing': ['Pottery']}},
     w('Hobbies: Reading, Writing, Drawing', 'Hobbies: Reading, Writing, Pottery (stopped drawing)'))
case('ext7-flask-mlh', "Flask: a friend's news", 'g-trap', {'forbidText': ['Google']},
     w(add='\nMy friend Tomi just got an internship at Google.\n'))

# ---------------------------------------------------------------- SvelteKit
w = setup('ext7-sveltekit-slick', 'resume.md', """# Riadh Adrani - resume

Education: Bachelor degree of Computer Science (ISTIC, Tunisia); PhD of Computer Science (MIT, USA)
Work: Open Source Developer (self-employed), Freelancer
""")
case('ext7-sveltekit-slick', 'SvelteKit: new degree', 'g-update', {'contains': {'~Bachelor degree of Computer Science': ["Master"]}, 'fieldsAny': ['~Bachelor degree of Computer Science']},
     w('Education: Bachelor degree of Computer Science (ISTIC, Tunisia)', "Education: Master's degree of Computer Science (ISTIC, Tunisia, 2026; replaces the bachelor entry)"))
case('ext7-sveltekit-slick', 'SvelteKit: role renamed', 'g-update', {'contains': {'~Open Source Developer': ['Maintainer']}},
     w('Work: Open Source Developer (self-employed)', 'Work: Open Source Maintainer (self-employed, renamed in 2026)'))
case('ext7-sveltekit-slick', 'SvelteKit: private matter', 'g-ignore', {'noProposals': True}, w(add='\nCall the bank about the card.\n'))

# ---------------------------------------------------------------- Vite + React (repo with the site one folder down)
w = setup('ext7-vite-react', 'notes.md', """# Brian Velazquez - notes

School: software engineering student at FGCU
Internship: IT Intern - Bonita Springs Utilities (January 2026 - Present)
""")
case('ext7-vite-react', 'Vite React: internship ended', 'g-update', {'contains': {'~January 2026 - Present': ['August 2026']}},
     w('(January 2026 - Present)', '(January 2026 - August 2026, finished)'))
case('ext7-vite-react', "Vite React: a classmate's competition", 'g-trap', {'forbidText': ['HackFGCU']},
     w(add='\nMy classmate Diego won HackFGCU this year.\n'))
case('ext7-vite-react', 'Vite React: private matter', 'g-ignore', {'noProposals': True}, w(add='\nGym at 6am tomorrow.\n'))

# ---------------------------------------------------------------- PHP
w = setup('own-php-cafe', 'cafe-notes.md', """# Little Fern Café - notes

Hours: Tuesday to Sunday, 7am to 3pm
Coffee: Roasted by Ruth Roasters in Detroit
Address: 214 West Cross Street, Ypsilanti, MI 48197
""")
case('own-php-cafe', 'PHP: opening hours', 'g-update', {'contains': {'~Open Tuesday to Sunday, 7am to 3pm': ['4pm']}},
     w('Hours: Tuesday to Sunday, 7am to 3pm', 'Hours: Tuesday to Sunday, 7am to 4pm (from November)'))
case('own-php-cafe', 'PHP: new coffee beans', 'g-update', {'contains': {'~Roasted by Ruth Roasters': ['Great Lakes']}},
     w('Coffee: Roasted by Ruth Roasters in Detroit', 'Coffee: Roasted by Great Lakes Coffee in Detroit (switched from Ruth Roasters)'))
case('own-php-cafe', 'PHP: a branch not decided yet', 'g-trap', {'forbidText': ['Ann Arbor']},
     w(add='\nThinking about a second location in Ann Arbor, nothing signed.\n'))

# ---------------------------------------------------------------- one HTML file from a chat assistant
w = setup('own-chatgpt-single', 'books.md', """# Marisol Vega - books

Base: Albuquerque, New Mexico
Agency: Brightline Literary Agency
Books:
- The Moth Who Loved the Moon (Pinecone Press, 2025)
- Abuela's Kitchen Garden (Little Harbor Books, 2023)
- Pip Finds a Home (Pinecone Press, 2021)
""")
case('own-chatgpt-single', 'Single-page HTML: new agency', 'g-update', {'contains': {'~Represented by Brightline': ['Northstar']}},
     w('Agency: Brightline Literary Agency', 'Agency: Northstar Literary (left Brightline in 2026)'))
case('own-chatgpt-single', 'Single-page HTML: book title changed', 'g-update', {'contains': {'~The Moth Who Loved the Moon': ['Moonlight Moth']}},
     w('- The Moth Who Loved the Moon (Pinecone Press, 2025)', '- The Moonlight Moth (Pinecone Press, 2025; retitled for the paperback)'))
case('own-chatgpt-single', 'Single-page HTML: an unannounced contract', 'g-trap', {'forbidText': ['Scholastic']},
     w(add='\nSigned with Scholastic for a new series (under embargo until March).\n'))

# ---------------------------------------------------------------- Replit full stack
w = setup('own-replit-fullstack', 'me.md', """# Dev Okafor

School: junior at Wayne State, Computer Science
Projects: Corner Store Inventory; Bus Buddy (text alerts when the DDOT bus is five minutes away)
""")
case('own-replit-fullstack', 'Replit: moved up a year', 'g-update', {'contains': {'~Junior at Wayne State': ['Senior']}},
     w('School: junior at Wayne State', 'School: senior at Wayne State'))
case('own-replit-fullstack', 'Replit: project update', 'g-update', {'contains': {'~Text alerts when the DDOT bus': ['ten minutes']}},
     w('five minutes away)', 'ten minutes away, changed after rider feedback)'))
case('own-replit-fullstack', 'Replit: private matter', 'g-ignore', {'noProposals': True}, w(add='\nDentist next Tuesday.\n'))

# ---------------------------------------------------------------- v0 (Next.js + shadcn)
w = setup('own-v0-studio', 'studio.md', """# Hana Sato Ceramics - studio notes

Studio: Portland, Oregon
Open studio: every first Saturday, 10am to 4pm
""")
case('own-v0-studio', 'v0: open day moved', 'g-update', {'contains': {'~Open studio every first Saturday': ['Sunday']}},
     w('Open studio: every first Saturday, 10am to 4pm', 'Open studio: every first Sunday, 11am to 5pm (from December)'))
case('own-v0-studio', 'v0: studio moved', 'g-update', {'contains': {'~small studio in Portland, Oregon': ['Seattle']}},
     w('Studio: Portland, Oregon', 'Studio: Seattle, Washington (moved in October 2026)'))
case('own-v0-studio', "v0: a client's private matter", 'g-trap', {'forbidText': ['wedding']},
     w(add='\nPrivate order: 120 cups for the Nakamura wedding, do not post.\n'))

json.dump({'version': 1, 'heldOut': True, 'note': 'Sites made by AI builders and chat assistants. Written before any model run; report only.', 'cases': CASES},
          open(os.path.join(ROOT, 'eval', 'cases-ext7.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(CASES), 'cases on', len({c['site'] for c in CASES}), 'sites')
