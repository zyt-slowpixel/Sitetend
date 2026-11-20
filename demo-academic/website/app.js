/* Academic homepage renderer. Standalone: loads ./content.json. Inside Sitetend: renders what the host sends.
   Every element that shows an editable value carries data-sk-field="<path>" so Sitetend can highlight it. */
(function () {
  var editable = false;
  function $(id) { return document.getElementById(id); }
  function txt(id, v) { var n = $(id); if (n) n.textContent = v == null ? '' : v; }
  function li(text, field) { var n = document.createElement('li'); n.textContent = text; if (field) n.setAttribute('data-sk-field', field); return n; }
  function span(cls, text, field) { var n = document.createElement('span'); n.className = cls; n.textContent = text; if (field) n.setAttribute('data-sk-field', field); return n; }
  function render(c) {
    var p = c.person || {};
    txt('name', p.fullName); txt('position', p.position); txt('department', p.department); txt('office', p.office); txt('bio', p.bio);
    var mail = $('email-link'); mail.textContent = p.emailAddress || ''; mail.href = 'mailto:' + (p.emailAddress || '');
    $('scholar-link').href = p.scholarProfile || '#';
    $('interests').replaceChildren.apply($('interests'), (c.researchInterests || []).map(function (x) { return li(x); }));
    $('news').replaceChildren.apply($('news'), (c.news || []).map(function (n) {
      var item = document.createElement('li'); item.append(span('d', n.date, 'news.' + n.id + '.date'), span('x', n.text, 'news.' + n.id + '.text')); return item; }));
    $('pubs').replaceChildren.apply($('pubs'), (c.publications || []).map(function (b) {
      var item = document.createElement('li'); var a = document.createElement('a'); a.href = b.link || '#'; a.className = 't'; a.textContent = b.title; a.setAttribute('data-sk-field', 'publications.' + b.id + '.title');
      item.append(a, span('a', b.authors, 'publications.' + b.id + '.authors'), span('v', b.venue + ' · ' + b.year, 'publications.' + b.id + '.venue')); return item; }));
    $('teaching').replaceChildren.apply($('teaching'), (c.teaching || []).map(function (t) { return li(t.course + ' - ' + t.term + ' (' + t.role + ')', 'teaching.' + t.id + '.course'); }));
    var lab = c.lab || {}; txt('lab-name', lab.name); txt('recruiting', lab.recruiting);
    $('members').replaceChildren.apply($('members'), (lab.members || []).map(function (x) { return li(x); }));
    txt('cv-rev', (c.cv || {}).lastRevised);
    document.body.classList.toggle('sk-editable', editable);
  }
  document.addEventListener('click', function (e) {
    if (!editable || window.parent === window) return;
    var n = e.target.closest && e.target.closest('[data-sk-field]'); if (!n) return;
    e.preventDefault(); window.parent.postMessage({ type: 'SITEKEEPER_PREVIEW_FIELD_CLICK', payload: { fieldPath: n.getAttribute('data-sk-field') } }, '*');
  });
  window.addEventListener('message', function (e) {
    if (window.parent === window || e.source !== window.parent || !e.data) return;
    if (e.data.type === 'SITEKEEPER_PREVIEW_RENDER' && e.data.payload) { editable = Boolean(e.data.payload.editable); render(e.data.payload.content); }
  });
  if (window.parent !== window) window.parent.postMessage({ type: 'SITEKEEPER_PREVIEW_READY' }, '*');
  else fetch('./content.json').then(function (r) { return r.json(); }).then(render).catch(function () { document.body.textContent = 'Serve this folder over HTTP to view it.'; });
})();
