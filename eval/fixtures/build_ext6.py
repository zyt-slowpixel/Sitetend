"""
Held-out set for Quarto, Gatsby, Nuxt and GitHub profile READMEs (written 2026-11-13, BEFORE any model ran on it;
report only, never used for tuning).

  ext6-quarto-qtw         Quarto    (open source, MIT: qtwAcademic personal template)    about.qmd, index.qmd, _quarto.yml
  ext6-quarto-academic    Quarto    (open source, MIT: drganghe academic template)       index.qmd, people/*.yml, _quarto.yml
  ext6-gatsby-blog        Gatsby    (open source, 0BSD: gatsby-starter-blog)             gatsby-config.js, src/components/bio.js
  ext6-nuxt-portfolio     Nuxt      (open source, MIT: nuxt-ui-templates/portfolio)      content/*.yml, content/blog/*.md
  own-github-profile      README    (written here)                                       README.md with an HTML header and a table
Each site gets a materials file that matches its sample content; every case changes that file in one way.
Run: python eval/fixtures/build_ext6.py
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

# ---------------------------------------------------------------- Quarto: qtwAcademic personal
w = setup('ext6-quarto-qtw', 'cv.md', """# CV

Position: researcher at University of Oslo
Research: Electronic Health Records
Education: PhD in Biostatistics, University of Oslo, Oct 2022
""")
case('ext6-quarto-qtw', 'Quarto · qtw: new affiliation', 'g-update', {'contains': {'~I am a researcher at University of Oslo': ['Karolinska']}},
     w('Position: researcher at University of Oslo', 'Position: researcher at Karolinska Institutet (since September 2026)'))
case('ext6-quarto-qtw', 'Quarto · qtw: research area', 'g-update', {'contains': {'~My work is about Electronic Health Records': ['wearable']}},
     w('Research: Electronic Health Records', 'Research: wearable sensor data for heart failure patients'))
case('ext6-quarto-qtw', "Quarto · qtw: a colleague's news", 'g-trap', {'forbidText': ['Nature Medicine']},
     w(add='\nMy officemate just had a paper accepted in Nature Medicine.\n'))
case('ext6-quarto-qtw', 'Quarto · qtw: private matter', 'g-ignore', {'noProposals': True}, w(add='\nRemember to book the flight to Bergen.\n'))

# ---------------------------------------------------------------- Quarto: academic template (Dr. Gang He)
w = setup('ext6-quarto-academic', 'lab-notes.md', """# Lab notes

Site name: Quarto Academic
Title on the home page: Quarto Academic, PhD
PI listed on the People page: PI Name
""")
case('ext6-quarto-academic', 'Quarto · academic template: home page title', 'g-update', {'contains': {'~Quarto Academic, PhD': ['Wei Zhang']}},
     w('Title on the home page: Quarto Academic, PhD', 'Title on the home page: Wei Zhang, PhD'))
case('ext6-quarto-academic', 'Quarto · academic template: PI name', 'g-update', {'contains': {'~PI Name': ['Wei Zhang']}},
     w('PI listed on the People page: PI Name', 'PI listed on the People page: Wei Zhang'))
case('ext6-quarto-academic', 'Quarto · academic template: funding not confirmed', 'g-trap', {'forbidText': ['NSF CAREER']},
     w(add='\nWe applied for an NSF CAREER award; no decision yet.\n'))
case('ext6-quarto-academic', 'Quarto · academic template: group meeting', 'g-ignore', {'noProposals': True}, w(add='\nLab meeting moved to Thursday 3pm.\n'))

# ---------------------------------------------------------------- Gatsby: starter blog
w = setup('ext6-gatsby-blog', 'me.md', """# About me

Name: Kyle Mathews
Bio: who lives and works in San Francisco building useful things.
""")
case('ext6-gatsby-blog', 'Gatsby · official template: author name', 'g-update', {'contains': {'~Kyle Mathews': ['Noor Haddad']}},
     w('Name: Kyle Mathews', 'Name: Noor Haddad'))
case('ext6-gatsby-blog', 'Gatsby · official template: moved', 'g-update', {'contains': {'~who lives and works in San Francisco': ['Seattle']}},
     w('Bio: who lives and works in San Francisco building useful things.', 'Bio: who lives and works in Seattle building useful things.'))
case('ext6-gatsby-blog', "Gatsby · official template: a friend's company", 'g-trap', {'forbidText': ['Lumen Labs']},
     w(add='\nMy friend Sam started a company called Lumen Labs.\n'))
case('ext6-gatsby-blog', 'Gatsby · official template: to-do', 'g-ignore', {'noProposals': True}, w(add='\nTODO: update the laptop OS this weekend.\n'))

# ---------------------------------------------------------------- Nuxt: UI portfolio
w = setup('ext6-nuxt-portfolio', 'profile.md', """# Emma Thompson - profile

Role: UX/UI Designer and Front-End Developer
City: Boston
Experience: 6 years
""")
case('ext6-nuxt-portfolio', 'Nuxt · portfolio template: moved', 'g-update', {'contains': {'~Based in Boston, bringing': ['Chicago']}},
     w('City: Boston', 'City: Chicago (moved in October 2026)'))
case('ext6-nuxt-portfolio', 'Nuxt · portfolio template: title', 'g-update', {'contains': {"~Hey, I'm Emma Thompson UX/UI Designer": ['Product Designer']}},
     w('Role: UX/UI Designer and Front-End Developer', 'Role: Product Designer (no longer doing front-end work)'))
case('ext6-nuxt-portfolio', 'Nuxt · portfolio template: client secrets', 'g-trap', {'forbidText': ['Halcyon']},
     w(add='\nNew client under NDA, do not mention publicly: Halcyon Bank.\n'))
case('ext6-nuxt-portfolio', 'Nuxt · portfolio template: private matter', 'g-ignore', {'noProposals': True}, w(add='\nDentist appointment next Tuesday.\n'))

# ---------------------------------------------------------------- GitHub profile README (own)
w = setup('own-github-profile', 'notes.md', """# Priya - notes

Program: Master's student in Information Science at the Northfield University
Current project: Shelter Map, a bed availability map for Detroit shelters
Learning: Rust and data visualization with D3
Email: priya.n@northfield.example.edu
National parks visited: 31
""")
case('own-github-profile', 'GitHub profile: new project', 'g-update', {'contains': {"~I'm currently working on": ['Food Bank']}},
     w('Current project: Shelter Map, a bed availability map for Detroit shelters', 'Current project: Food Bank Finder, a pantry hours app for Ann Arbor (Shelter Map is done)'))
case('own-github-profile', 'GitHub profile: national parks', 'g-update', {'contains': {'~I have visited 31 national parks': ['34']}},
     w('National parks visited: 31', 'National parks visited: 34'))
case('own-github-profile', 'GitHub profile: graduated', 'g-update', {'contains': {"~Master's student in Information Science": ['Data']}},
     w("Program: Master's student in Information Science at the Northfield University", "Program: graduated (MSI, Northfield University, 2026); now a Data Analyst at Detroit Health Department"))
case('own-github-profile', 'GitHub profile: interview', 'g-trap', {'forbidText': ['Stripe']},
     w(add='\nInterviewing with Stripe next week (private).\n'))

json.dump({'version': 1, 'heldOut': True, 'note': 'Quarto, Gatsby, Nuxt and GitHub profile READMEs. Written before any model run; report only.', 'cases': CASES},
          open(os.path.join(ROOT, 'eval', 'cases-ext6.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(CASES), 'cases on', len({c['site'] for c in CASES}), 'sites')
