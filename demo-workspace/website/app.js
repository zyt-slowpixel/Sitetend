/**
 * Demo Portfolio Application Script (demo-workspace/website/app.js)
 *
 * Works in two modes:
 * 1. Standalone Website Mode: fetches `./content.json` and renders the portfolio.
 * 2. Sitetend Preview Mode: receives `{ type: 'SITEKEEPER_PREVIEW_RENDER', payload }`
 *    via `window.postMessage`, renders live or draft content, highlights editable
 *    fields (`data-sk-field`), and emits `SITEKEEPER_PREVIEW_FIELD_CLICK` on click.
 */

(function () {
  let currentContent = null;
  let activeCategory = 'all';
  let isEditableMode = false;
  let activeFieldPath = null;

  function renderAvatarSvg(theme) {
    if (theme === 'avatar-monogram') {
      return `<svg viewBox="0 0 200 140" width="100%" height="100%">
        <rect width="200" height="140" fill="#e3e7ee"/>
        <circle cx="100" cy="70" r="46" fill="none" stroke="#3f5578" stroke-opacity="0.35"/>
        <text x="100" y="82" text-anchor="middle" fill="#22201c" font-size="34" font-weight="500" font-family="Georgia, serif">AM</text>
      </svg>`;
    }
    if (theme === 'avatar-wave') {
      return `<svg viewBox="0 0 200 140" width="100%" height="100%">
        <rect width="200" height="140" fill="#e3e8e1"/>
        <path d="M0 95 Q50 55 100 95 T200 95 L200 140 L0 140 Z" fill="#46644e" opacity="0.18"/>
        <circle cx="100" cy="56" r="22" fill="#fbfaf7"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 200 140" width="100%" height="100%">
      <rect width="200" height="140" fill="#ece8e0"/>
      <circle cx="78" cy="70" r="36" fill="#3f5578" opacity="0.8"/>
      <rect x="96" y="38" width="64" height="64" rx="14" fill="#c9b79a" opacity="0.75"/>
      <circle cx="128" cy="70" r="12" fill="#fbfaf7"/>
    </svg>`;
  }

  function renderSite(content) {
    if (!content) return;
    currentContent = content;

    const profile = content.profile || {};
    const about = content.about || {};
    const resume = content.resume || {};
    const contact = content.contact || {};

    // Profile & Nav & Footer Name
    document.title = `${profile.name || 'Portfolio'} - ${profile.role || ''}`;
    setText('nav-name', profile.name);
    setText('hero-name', profile.name);
    setText('footer-name', profile.name);
    setText('hero-badge', profile.badge);
    setText('hero-role', profile.role);
    setText('hero-tagline', profile.tagline);

    const avatarGraphic = document.getElementById('avatar-graphic');
    if (avatarGraphic) {
      avatarGraphic.innerHTML = renderAvatarSvg(profile.avatarUrl || 'avatar-geometric');
    }

    // Contact & Email synchronization across Hero, Contact, and Footer
    const email = contact.email || '';
    const heroEmailBtn = document.getElementById('hero-email-btn');
    if (heroEmailBtn) {
      heroEmailBtn.href = `mailto:${email}`;
      heroEmailBtn.textContent = `Email ${email}`;
    }
    const contactEmailLink = document.getElementById('contact-email-link');
    if (contactEmailLink) {
      contactEmailLink.href = `mailto:${email}`;
      contactEmailLink.textContent = email;
    }
    const footerEmail = document.getElementById('footer-email');
    if (footerEmail) {
      footerEmail.href = `mailto:${email}`;
      footerEmail.textContent = email;
    }

    setText('about-location', contact.location);
    setText('contact-location', contact.location);
    setText('contact-headline', contact.headline);

    const ghLink = document.getElementById('contact-github-link');
    if (ghLink && contact.github) ghLink.href = contact.github;
    const liLink = document.getElementById('contact-linkedin-link');
    if (liLink && contact.linkedin) liLink.href = contact.linkedin;

    // About
    setText('about-headline', about.headline);
    setText('about-summary', about.summary);
    const focusContainer = document.getElementById('about-focus-areas');
    if (focusContainer) {
      focusContainer.innerHTML = (about.focusAreas || [])
        .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
        .join('');
    }

    // Resume
    setText('resume-headline', resume.headline);
    setText('resume-updated', resume.updatedLabel);
    setText('resume-summary', resume.summary);
    const resumePath = resume.downloadPath || 'assets/resume.pdf';
    setText('resume-path-text', /^(blob|data):/.test(resumePath) ? 'PDF' : resumePath);
    const resumeLink = document.getElementById('resume-download-link');
    if (resumeLink) {
      resumeLink.href = resume.downloadPath || 'assets/resume.pdf';
    }

    const expList = document.getElementById('resume-experience-list');
    if (expList) {
      expList.innerHTML = (resume.experience || [])
        .map(
          (item) => `
          <div class="experience-item">
            <strong>${escapeHtml(item.role)}</strong> · ${escapeHtml(item.org)}
            <div class="resume-meta">${escapeHtml(item.period)}</div>
            <p>${escapeHtml(item.detail)}</p>
          </div>`
        )
        .join('');
    }

    renderCategoriesAndProjects(content.projects || []);
    applyEditModeState();
  }

  function renderCategoriesAndProjects(projects) {
    const filterBar = document.getElementById('project-filters');
    const categories = ['all', ...new Set(projects.map((p) => p.category).filter(Boolean))];

    if (filterBar) {
      filterBar.innerHTML = categories
        .map(
          (cat) => `
          <button type="button" class="filter-btn ${cat === activeCategory ? 'active' : ''}" data-category="${escapeHtml(cat)}">
            ${cat === 'all' ? 'All Work' : escapeHtml(cat)}
          </button>`
        )
        .join('');

      filterBar.querySelectorAll('.filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeCategory = btn.getAttribute('data-category') || 'all';
          renderCategoriesAndProjects(currentContent.projects || []);
          applyEditModeState();
        });
      });
    }

    const grid = document.getElementById('projects-grid');
    if (!grid) return;

    const visibleProjects =
      activeCategory === 'all'
        ? projects
        : projects.filter((p) => p.category === activeCategory);

    grid.innerHTML = visibleProjects
      .map((p) => {
        const themeClass = `theme-${p.visualTheme || 'orbit-constellation'}`;
        return `
        <article class="project-card" data-project-id="${escapeHtml(p.id)}">
          <div class="project-visual ${escapeHtml(themeClass)}" data-sk-field="projects.${escapeHtml(p.id)}.visualTheme">
            <span>${escapeHtml(p.title)}</span>
          </div>
          <div class="project-body">
            <div class="project-meta">
              <span data-sk-field="projects.${escapeHtml(p.id)}.category">${escapeHtml(p.category)}</span>
              <span data-sk-field="projects.${escapeHtml(p.id)}.year">${escapeHtml(p.year)}</span>
            </div>
            <h3 class="project-title" data-sk-field="projects.${escapeHtml(p.id)}.title">${escapeHtml(p.title)}</h3>
            <p class="project-summary" data-sk-field="projects.${escapeHtml(p.id)}.summary">${escapeHtml(p.summary)}</p>
            <div class="project-footer">
              <button type="button" class="link-btn open-modal-btn" data-project-id="${escapeHtml(p.id)}">
                Inspect Case Study &rarr;
              </button>
            </div>
          </div>
        </article>`;
      })
      .join('');

    grid.querySelectorAll('.open-modal-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pid = btn.getAttribute('data-project-id');
        openProjectModal(pid);
      });
    });
  }

  function openProjectModal(projectId) {
    const proj = (currentContent?.projects || []).find((p) => p.id === projectId);
    if (!proj) return;

    const modal = document.getElementById('project-modal');
    const body = document.getElementById('modal-body');
    if (!modal || !body) return;

    body.innerHTML = `
      <span class="eyebrow" data-sk-field="projects.${escapeHtml(proj.id)}.category">${escapeHtml(proj.category)} · ${escapeHtml(proj.year)}</span>
      <h2 id="modal-title" style="margin-bottom: 12px;" data-sk-field="projects.${escapeHtml(proj.id)}.title">${escapeHtml(proj.title)}</h2>
      <p class="modal-overview" style="margin-bottom: 18px;" data-sk-field="projects.${escapeHtml(proj.id)}.detailOverview">${escapeHtml(proj.detailOverview || proj.summary)}</p>
      <h4 style="margin-bottom: 8px;">Key Highlights &amp; Evidence</h4>
      <ul style="padding-left: 20px; margin-bottom: 20px;" data-sk-field="projects.${escapeHtml(proj.id)}.highlights">
        ${(proj.highlights || []).map((h) => `<li style="margin-bottom:6px;">${escapeHtml(h)}</li>`).join('')}
      </ul>
      <a href="${escapeHtml(proj.link || '#')}" target="_blank" rel="noopener" class="btn btn-outline" data-sk-field="projects.${escapeHtml(proj.id)}.link">
        Repository / Artifact Link
      </a>
    `;

    modal.classList.remove('hidden');
    applyEditModeState();
  }

  function applyEditModeState() {
    const banner = document.getElementById('sk-edit-banner');
    if (isEditableMode) {
      document.body.classList.add('sk-editable');
      if (banner) banner.classList.remove('hidden');
    } else {
      document.body.classList.remove('sk-editable');
      if (banner) banner.classList.add('hidden');
    }

    document.querySelectorAll('[data-sk-field]').forEach((el) => {
      const path = el.getAttribute('data-sk-field');
      if (activeFieldPath && path === activeFieldPath) {
        el.classList.add('sk-active-field');
      } else {
        el.classList.remove('sk-active-field');
      }
    });
  }

  // Click-to-edit interception in Sitetend Draft Preview mode
  document.addEventListener(
    'click',
    (e) => {
      if (!isEditableMode) return;
      const target = e.target.closest('[data-sk-field]');
      if (!target) return;

      e.preventDefault();
      e.stopPropagation();
      const fieldPath = target.getAttribute('data-sk-field');
      activeFieldPath = fieldPath;
      applyEditModeState();

      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'SITEKEEPER_PREVIEW_FIELD_CLICK',
            payload: { fieldPath },
          },
          '*'
        );
      }
    },
    true
  );

  // srcdoc uses the parent's base URL; keep hash navigation inside the preview.
  if (window.parent !== window) document.addEventListener('click', e => {
    const anchor = e.target.closest('a[href^="#"]');
    if (!anchor) return;
    e.preventDefault();
    const target = document.getElementById(anchor.getAttribute('href').slice(1));
    if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
  });

  // Close modal handlers
  const closeBtn = document.getElementById('modal-close-btn');
  const modal = document.getElementById('project-modal');
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  // Message Listener from Sitetend Host
  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'SITEKEEPER_PREVIEW_RENDER' && msg.payload) {
      isEditableMode = Boolean(msg.payload.editable);
      activeFieldPath = msg.payload.activeFieldPath || null;
      renderSite(msg.payload.content);
    } else if (msg.type === 'SITEKEEPER_PREVIEW_HIGHLIGHT') {
      activeFieldPath = msg.payload?.fieldPath || null;
      applyEditModeState();
      if (activeFieldPath) {
        const el = document.querySelector(`[data-sk-field="${activeFieldPath}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '';
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (window.parent !== window) {
    window.parent.postMessage({type: 'SITEKEEPER_PREVIEW_READY'}, '*');
  } else {
    fetch('./content.json').then(r => {if(!r.ok) throw Error('Content unavailable'); return r.json();})
      .then(renderSite).catch(() => { document.body.textContent = 'Unable to load content. Serve this folder over HTTP.'; });
  }
})();
