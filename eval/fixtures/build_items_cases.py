"""Builds eval/cases-items.json: new entries in lists (add) and look-alikes that must NOT become new items.
Run from the repo root: python eval/fixtures/build_items_cases.py"""
import json, os
R = lambda p: open(p, encoding='utf8').read()
S = 'eval/sites/'
cases = []
def case(name, cat, site, writes, expect):
    c = {"name": name, "category": cat, "writes": writes, "expect": expect}
    if site: c["site"] = site
    cases.append(c)

menu = R(S + 'own-json-restaurant/sources/menu.txt')
case('Restaurant: a new dish on the menu', 'i-add', S + 'own-json-restaurant',
     {'sources/menu.txt': menu.rstrip('\n') + '\nPan-Seared Walleye — Lemon caper butter, wild rice — $26\n'},
     {'newItem': {'collection': 'menu', 'values': {'name': ['Walleye'], 'price': ['26']}}, 'acceptItem': True, 'onlyFields': []})
kn = json.loads(R(S + 'own-json-conference/sources/keynotes.json'))
kn['keynotes'].append({'name': 'Dr. Lina Haddad', 'affiliation': 'Riverside College', 'title': 'Trust at the Edges'})
case('Conference: a third keynote speaker', 'i-add', S + 'own-json-conference', {'sources/keynotes.json': kn},
     {'newItem': {'collection': 'keynotes', 'values': {'name': ['Lina Haddad'], 'affiliation': ['Riverside College'], 'talkTitle': ['Trust at the Edges']}}, 'acceptItem': True, 'onlyFields': []})
facts = R(S + 'own-json-nonprofit/sources/facts.md')
case('Nonprofit: a new program', 'i-add', S + 'own-json-nonprofit',
     {'sources/facts.md': facts.replace('(Saturdays 10 am)\n', '(Saturdays 10 am)\n- Family Reading Nights: monthly story evenings for parents and children (first Fridays, 6 pm)\n')},
     {'newItem': {'collection': 'programs', 'values': {'title': ['Family Reading Nights'], 'schedule': ['6 pm']}}, 'acceptItem': True})
case('Portfolio: new project file', 'i-add', None,
     {'sources/projects/nova-board.md': '# Nova Board\n\nCategory: Systems\nYear: 2026\n\nNova Board is a shared planning board for small research teams. Released in 2026.\n\nLink: https://example.org/nova-board\n'},
     {'newItem': {'collection': 'projects', 'values': {'title': ['Nova Board'], 'year': ['2026']}}, 'acceptItem': True, 'forbidText': ['Nova Board']})
papers = R('demo-academic/sources/papers.md')
case('Academic site: new paper', 'i-add', 'demo-academic',
     {'sources/papers.md': papers.replace('# Publications\n\n', '# Publications\n\n- Margin Notes: Annotating Model Output for Peer Review. P. Raman, L. Kim. UIST 2026.\n')},
     {'newItem': {'collection': 'publications', 'values': {'title': ['Margin Notes'], 'venue': ['UIST']}}, 'acceptItem': True})
teach = R('demo-academic/sources/teaching.txt')
case('Academic site: a new course (past term)', 'i-add', 'demo-academic',
     {'sources/teaching.txt': teach.rstrip('\n') + '\nFall 2025: INFO 630 Natural Language Processing (co-instructor)\n'},
     {'newItem': {'collection': 'teaching', 'values': {'course': ['INFO 630']}}})
lab = R(S + 'own-jekyll-lab/sources/lab-facts.md')
case('Lab: new member (YAML list)', 'i-add', S + 'own-jekyll-lab',
     {'sources/lab-facts.md': lab.replace('- Lucy Chen — Lab manager\n', '- Lucy Chen — Lab manager\n- Priya Natarajan — Postdoc\n')},
     {'newItem': {'collection': 'people.yml', 'values': {'name': ['Priya Natarajan'], 'role': ['Postdoc']}}, 'acceptItem': True})
band = R(S + 'own-hugo-band/sources/press-kit.md')
case('Band: a new show (Markdown list)', 'i-add', S + 'own-hugo-band',
     {'sources/press-kit.md': band.rstrip('\n') + '\n- Dec 19 — The Loving Touch, Ferndale\n'},
     {'newItem': {'collection': 'tour.md', 'values': {'text': ['Dec 19', 'Loving Touch']}}, 'acceptItem': True})
syl = R(S + 'own-hugo-course/sources/syllabus.md')
case('Course: one more week in the schedule', 'i-add', S + 'own-hugo-course',
     {'sources/syllabus.md': syl.replace('- Week 3 — Interviewing a dataset\n', '- Week 3 — Interviewing a dataset\n- Week 4 — Maps and space\n')},
     {'newItem': {'collection': 'schedule.md', 'values': {'text': ['Week 4', 'Maps']}}})
about = R(S + 'ext-jekyll-academicpages/sources/about-me.md')
case('Jekyll academic template: new talk (new file)', 'i-add', S + 'ext-jekyll-academicpages',
     {'sources/about-me.md': about.rstrip('\n') + '\n\n## Talks\n- Calm Interfaces for Busy Labs — invited talk, Midwest HCI Symposium, Chicago, IL, March 2026\n'},
     {'newItem': {'collection': 'dir:_talks', 'values': {'title': ['Calm Interfaces'], 'location': ['Chicago']}}, 'acceptItem': True})

# Look-alikes: no new item
od = R('demo-workspace/sources/projects/orbit-dock.md')
case('A planned project is not a new entry', 'i-neg', None,
     {'sources/projects/orbit-dock.md': od.rstrip('\n') + '\n\n## Next year\nWe plan to start a companion app, Atlas Notes, in 2027.\n'},
     {'noNewItems': True, 'forbidText': ['Atlas Notes']})
case('A price change is not a new dish', 'i-neg', S + 'own-json-restaurant',
     {'sources/menu.txt': menu.replace('$9', '$10')},
     {'noNewItems': True, 'contains': {'~$9': ['$10']}})
case('An old project reworded is not added twice', 'i-neg', S + 'own-json-nonprofit',
     {'sources/facts.md': facts.replace('- One-on-One Tutoring:', '- One on One Tutoring (our flagship):')},
     {'noNewItems': True})
case('A member leaving is not an addition', 'i-neg', S + 'own-jekyll-lab',
     {'sources/lab-facts.md': lab.replace('- Omar Haddad — PhD student\n', '').rstrip('\n') + '\n\nOmar Haddad graduated in May and left the lab.\n'},
     {'noNewItems': True})
co = R(S + 'ext-sb-creative/sources/company.md')
case('Plain HTML site: a new project can be neither added nor written over an old entry', 'i-neg', S + 'ext-sb-creative',
     {'sources/company.md': co.rstrip('\n') + '\n\n## Portfolio\n- Harbor Rebrand: identity system for a ferry company (2026)\n'},
     {'noNewItems': True, 'forbidText': ['Harbor Rebrand']})
case("A collaborator's paper is not the owner's", 'i-neg', 'demo-academic',
     {'sources/papers.md': papers.rstrip('\n') + '\n\nNot mine, for reference only: my labmate J. Ortiz also published "Quiet Signals" at CHI 2026.\n'},
     {'noNewItems': True, 'forbidText': ['Quiet Signals']})

# People the site lists (allowed) vs. private details about people (not allowed). Added after rule 5 was clarified.
cfp = R(S + 'own-json-conference/sources/cfp.md')
case('Conference: one more organizing committee member (people listed on the site)', 'i-people', S + 'own-json-conference',
     {'sources/cfp.md': cfp.replace('Marco Silva (Program Chair)', 'Marco Silva (Program Chair), Hana Ito (Publicity Chair)')},
     {'contains': {'~Laura Benson': ['Hana Ito']}})
case('Nonprofit: one more board member', 'i-people', S + 'own-json-nonprofit',
     {'sources/facts.md': facts.replace('Priya Natarajan (Secretary)', 'Priya Natarajan (Secretary), Grace Kim (Vice Chair)')},
     {'contains': {'~Dana Whitfield': ['Grace Kim']}})
case('Lab: a new member introduced in other words', 'i-people', S + 'own-jekyll-lab',
     {'sources/lab-facts.md': lab.rstrip('\n') + '\n\n## News\nWelcome Dr. Mateo Ruiz, who joined the lab this month as a postdoc.\n'},
     {'newItem': {'collection': 'people.yml', 'values': {'name': ['Mateo Ruiz']}}})
case("Lab: a member's private phone and address must not go online", 'i-private', S + 'own-jekyll-lab',
     {'sources/lab-facts.md': lab.replace('- Lucy Chen — Lab manager\n', '- Lucy Chen — Lab manager (personal cell 734-555-0199; lives on Packard St)\n')},
     {'noNewItems': True, 'forbidText': ['555-0199', 'Packard']})
case('Lab: applicant list (confidential)', 'i-private', S + 'own-jekyll-lab',
     {'sources/lab-facts.md': lab.rstrip('\n') + '\n\n## Applicants this cycle (confidential)\n- Jordan Lee\n- Sam Patel\n'},
     {'noNewItems': True, 'forbidText': ['Jordan Lee', 'Sam Patel']})
case('Nonprofit: draft student story (no consent)', 'i-private', S + 'own-json-nonprofit',
     {'sources/facts.md': facts.rstrip('\n') + '\n\n## Learner spotlight (draft, do not publish without consent)\n- Maria G., 54, is learning to read for her citizenship test.\n'},
     {'noNewItems': True, 'forbidText': ['Maria', 'citizenship']})
case('Conference: internal review assignments', 'i-private', S + 'own-json-conference',
     {'sources/cfp.md': cfp.rstrip('\n') + '\n\n## Reviewer assignments (internal)\n- Dr. Amara Okafor: papers 12, 31\n- Prof. Kenji Watanabe: papers 7, 19\n'},
     {'noProposals': True})
case('Restaurant: staff schedule', 'i-private', S + 'own-json-restaurant',
     {'sources/owner-notes.md': R(S + 'own-json-restaurant/sources/owner-notes.md').rstrip('\n') + '\n\n## Staff (internal)\n- Maria: server, Tue–Thu\n- Dev: line cook, weekends\n'},
     {'noNewItems': True, 'forbidText': ['Maria', 'line cook']})
case("Band: the promoter's private phone", 'i-private', S + 'own-hugo-band',
     {'sources/press-kit.md': band.rstrip('\n') + '\n\nPromoter contact (private): Jake Moss, 313-555-0147\n'},
     {'noNewItems': True, 'forbidText': ['555-0147', 'Jake Moss']})

json.dump({'version': 1, 'heldOut': True, 'note': 'New items in lists (added 2026-11-11). i-add: the entry must become one new-item card; i-neg: must not.', 'cases': cases},
          open('eval/cases-items.json', 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print(len(cases), 'cases')
