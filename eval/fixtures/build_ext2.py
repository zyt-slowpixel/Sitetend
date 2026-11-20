"""
Second held-out set of open-source sites (written 2026-11-12, BEFORE any model ran on it; report only, never used for tuning).

7 more MIT-licensed templates, copied as-is into eval/sites/ext2-* (text files only; see eval/sites/THIRD_PARTY.md):
  static HTML: vCard personal portfolio, Start Bootstrap Personal (built pages)
  Hugo:        PaperMod (exampleSite, config.yml, multilingual), hugo-profile (exampleSite, hugo.yaml with CRLF line endings,
               English + Spanish + French in one file)
  Jekyll:      al-folio (large academic site), Jekyll Now, Chirpy (starter)
Each site gets a materials file that matches its sample content; every case changes that file in one way.
Run: python eval/fixtures/build_ext2.py
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

# ---------------------------------------------------------------- static HTML: vCard (Richard Hanrick)
w = setup('ext2-html-vcard', 'profile.md', """# Richard Hanrick (profile)

Role: Web developer
Email: richard@example.com
Location: Sacramento, California, USA
About: I'm Creative Director and UI/UX Designer from Sydney, Australia, working in web development and print media.
""")
case('ext2-html-vcard', 'Ext2 · vCard (HTML): job title', 'x-update', {'contains': {'~Web developer': ['Senior']}}, w('Role: Web developer', 'Role: Senior web developer'))
case('ext2-html-vcard', 'Ext2 · vCard (HTML): moved', 'x-update', {'contains': {'~Sacramento, California': ['Portland']}}, w('Location: Sacramento, California, USA', 'Location: Portland, Oregon, USA'))
case('ext2-html-vcard', "Ext2 · vCard (HTML): someone else's email", 'x-trap', {'forbid': ['~richard@example.com'], 'forbidText': ['jessica@']},
     w(add='\nNote: ask Jessica Miller (jessica@studio.example) for the new logo files.\n'))
case('ext2-html-vcard', 'Ext2 · vCard (HTML): private reminder', 'x-ignore', {'noProposals': True}, w(add='\nReminder: book the dentist for next Tuesday.\n'))

# ---------------------------------------------------------------- static HTML: Start Bootstrap Personal (multi-page)
w = setup('ext2-html-sbpersonal', 'resume.md', """# Resume

## Experience
- 2019 - Present: Web Developer, Stark Industries, Los Angeles, CA
- SEM Specialist, Wayne Enterprises, Gotham City, NY

## Education
- Barnett College, Fairfield, NY - Master's, Web Development
""")
case('ext2-html-sbpersonal', 'Ext2 · personal site (multi-page HTML): promotion', 'x-update', {'contains': {'~Web Developer': ['Senior']}},
     w('Web Developer, Stark Industries', 'Senior Web Developer, Stark Industries'))
case('ext2-html-sbpersonal', 'Ext2 · personal site (multi-page HTML): work location', 'x-update', {'contains': {'~Los Angeles, CA': ['San Diego']}},
     w('Stark Industries, Los Angeles, CA', 'Stark Industries, San Diego, CA'))
case('ext2-html-sbpersonal', 'Ext2 · personal site (multi-page HTML): new job not started yet', 'x-trap', {'forbid': ['~Web Developer', '~Stark Industries'], 'forbidText': ['Oscorp']},
     w(add='\nPlanned (not announced yet): Lead Developer at Oscorp, starting next spring.\n'))
case('ext2-html-sbpersonal', 'Ext2 · personal site (multi-page HTML): private to-do', 'x-ignore', {'noProposals': True}, w(add='\nTODO: renew the domain before March.\n'))

# ---------------------------------------------------------------- Hugo: PaperMod (config.yml, en/fr/fa)
w = setup('ext2-hugo-papermod', 'site-notes.md', """# PaperMod demo site notes

About page description: A fast, clean, and responsive Hugo theme designed for bloggers and content creators.
Home intro title: PaperMod's Demo
""")
case('ext2-hugo-papermod', 'Ext2 · PaperMod (Hugo): about-page intro', 'x-update', {'contains': {'~A fast, clean, and responsive Hugo theme': ['writers']}},
     w('designed for bloggers and content creators', 'designed for bloggers, writers and content creators'))
case('ext2-hugo-papermod', 'Ext2 · PaperMod (Hugo): home page title', 'x-update', {'contains': {"~PaperMod's Demo": ['Showcase']}},
     w("Home intro title: PaperMod's Demo", 'Home intro title: PaperMod Showcase'))
case('ext2-hugo-papermod', 'Ext2 · PaperMod (Hugo): French/Persian pages must not change', 'x-trap', {'forbid': ['~PaperModL2', '~PaperMod RTL', '~Welcome to RTL layout']},
     w("Home intro title: PaperMod's Demo", 'Home intro title: PaperMod Showcase'))
case('ext2-hugo-papermod', 'Ext2 · PaperMod (Hugo): issue notes', 'x-ignore', {'noProposals': True}, w(add='\nOpen issue: the search page is slow on large sites.\n'))

# ---------------------------------------------------------------- Hugo: hugo-profile (hugo.yaml, CRLF, en/es/fr)
w = setup('ext2-hugo-profile', 'about-isabella.md', """# Isabella (about me)

Tagline: I build things for the web
Intro: A passionate web app developer. I tend to make use of modern web technologies to build websites that look great, feel fantastic, and function correctly.
Current job: Senior Software Developer at Facebook
Achievement: Hugo Profile - Developed a theme and getting 1K+ downloads per month.
""")
case('ext2-hugo-profile', 'Ext2 · hugo-profile (Hugo): one-line intro', 'x-update', {'contains': {'~I build things for the web': ['accessible']}},
     w('Tagline: I build things for the web', 'Tagline: I build accessible things for the web'))
case('ext2-hugo-profile', 'Ext2 · hugo-profile (Hugo): download count', 'x-update', {'contains': {'~1K+ downloads per month': ['5K+']}},
     w('getting 1K+ downloads per month', 'getting 5K+ downloads per month'))
case('ext2-hugo-profile', 'Ext2 · hugo-profile (Hugo): English material must not change Spanish/French pages', 'x-trap', {'forbid': ['~Construyo cosas para la web', '~Je construis']},
     w('Tagline: I build things for the web', 'Tagline: I build accessible things for the web'))
case('ext2-hugo-profile', 'Ext2 · hugo-profile (Hugo): private notes', 'x-ignore', {'noProposals': True}, w(add='\nPersonal: call mom on Sunday.\n'))

# ---------------------------------------------------------------- Jekyll: al-folio (large academic site)
w = setup('ext2-jekyll-alfolio', 'academic-profile.md', """# Academic profile

Subtitle: <a href='#'>Affiliations</a>. Address. Contacts. Motto. Etc.
Blog description: a simple whitespace theme for academics
""")
case('ext2-jekyll-alfolio', 'Ext2 · al-folio (Jekyll): blog description', 'x-update', {'contains': {'~a simple whitespace theme for academics': ['clean']}},
     w('Blog description: a simple whitespace theme for academics', 'Blog description: a simple, clean whitespace theme for academics'))
case('ext2-jekyll-alfolio', 'Ext2 · al-folio (Jekyll): affiliation', 'x-update', {'contains': {'~Address. Contacts. Motto': ['Northfield University']}},
     w("<a href='#'>Affiliations</a>", "<a href='#'>Northfield University</a>"))
case('ext2-jekyll-alfolio', "Ext2 · al-folio (Jekyll): a collaborator's news", 'x-trap', {'forbidText': ['Stanford', 'Dana']},
     w(add='\nNews about a coauthor: Dana Smith moved to Stanford this fall.\n'))
case('ext2-jekyll-alfolio', 'Ext2 · al-folio (Jekyll): review schedule', 'x-ignore', {'noProposals': True}, w(add='\nReviewer comments for the workshop are due Friday.\n'))

# ---------------------------------------------------------------- Jekyll: Jekyll Now
w = setup('ext2-jekyll-now', 'me.md', """# About me

Name: Your Name
Description: Web Developer from Somewhere
Email: email@domain.com
""")
case('ext2-jekyll-now', 'Ext2 · Jekyll Now: city', 'x-update', {'contains': {'~Web Developer from Somewhere': ['Detroit']}},
     w('Description: Web Developer from Somewhere', 'Description: Web Developer from Detroit'))
case('ext2-jekyll-now', 'Ext2 · Jekyll Now: contact email', 'x-update', {'contains': {'~email@domain.com': ['me@newdomain.com']}},
     w('Email: email@domain.com', 'Email: me@newdomain.com'))
case('ext2-jekyll-now', "Ext2 · Jekyll Now: a friend's website", 'x-trap', {'forbidText': ['barry.example']},
     w(add="\nMy friend Barry's site: https://barry.example\n"))
case('ext2-jekyll-now', 'Ext2 · Jekyll Now: shopping list', 'x-ignore', {'noProposals': True}, w(add='\nShopping: milk, eggs, coffee.\n'))

# ---------------------------------------------------------------- Jekyll: Chirpy (starter)
w = setup('ext2-jekyll-chirpy', 'blog-settings.md', """# Blog settings

Title: Chirpy
Tagline: A text-focused Jekyll theme
Contact email: example@domain.com
""")
case('ext2-jekyll-chirpy', 'Ext2 · Chirpy (Jekyll): subtitle', 'x-update', {'contains': {'~A text-focused Jekyll theme': ['writers']}},
     w('Tagline: A text-focused Jekyll theme', 'Tagline: A text-focused Jekyll theme for writers'))
case('ext2-jekyll-chirpy', 'Ext2 · Chirpy (Jekyll): contact email', 'x-update', {'contains': {'~example@domain.com': ['hi@chirpy.example']}},
     w('Contact email: example@domain.com', 'Contact email: hi@chirpy.example'))
case('ext2-jekyll-chirpy', "Ext2 · Chirpy (Jekyll): someone else's account", 'x-trap', {'forbidText': ['octo-friend']},
     w(add='\nThanks to @octo-friend on GitHub for the dark-mode fix.\n'))
case('ext2-jekyll-chirpy', 'Ext2 · Chirpy (Jekyll): draft ideas', 'x-ignore', {'noProposals': True}, w(add='\nIdea for later: a post about keyboard shortcuts.\n'))

json.dump({'version': 1, 'heldOut': True, 'note': 'Second held-out set: 7 more open-source sites. Written before any model run; report only.', 'cases': CASES},
          open(os.path.join(ROOT, 'eval', 'cases-ext2.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(CASES), 'cases on', len({c['site'] for c in CASES}), 'sites')
