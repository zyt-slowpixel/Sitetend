// Step-by-step guide: dims the page, lights up one area, and explains it in a bubble next to it.
// No library. Each step: { target: () => Element|null, title, body, wait?: () => Element|null (re-checked while shown),
// foundBody?: text once the awaited element appears }.
// A step whose target is missing or hidden is skipped. Esc skips the tour; ←/→ and Enter move between steps.

const PAD = 6, GAP = 12, MARGIN = 12;

export function startTour({ steps, t, onEnd = () => {}, onStep = () => {} }) {
  document.getElementById('tour')?.remove();
  const root = document.createElement('div');
  root.id = 'tour'; root.className = 'tour'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
  const hole = document.createElement('div'); hole.className = 'tour-hole';
  const bubble = document.createElement('div'); bubble.className = 'tour-bubble'; bubble.tabIndex = -1;
  root.append(hole, bubble);
  document.body.append(root);

  let i = -1, poll = null, frame = 0, cur = null;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = n => n && n.isConnected && n.getClientRects().length && !n.closest('[hidden]');
  const usable = s => visible(s.target()) || Boolean(s.wait);

  /** Where the outline and the bubble should be now: around the lit area, the bubble below / above / beside it. */
  function wanted() {
    const s = steps[i]; if (!s) return null;
    const n = s.target();
    const r = visible(n) ? n.getBoundingClientRect() : null;
    const hole = r ? { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2, o: 1 }
      : { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0, o: 0 };
    const b = bubble.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    let x, y;
    if (!r) { x = (W - b.width) / 2; y = (H - b.height) / 2; }
    // side: 'left' keeps the bubble toward the middle of the screen for things in the top-right corner
    else if (s.side === 'left' && r.left - PAD - GAP - b.width >= MARGIN) { x = r.left - PAD - GAP - b.width; y = r.top - PAD; }
    else if (r.bottom + PAD + GAP + b.height <= H - MARGIN) { y = r.bottom + PAD + GAP; x = r.left; }
    else if (r.top - PAD - GAP - b.height >= MARGIN) { y = r.top - PAD - GAP - b.height; x = r.left; }
    else if (r.right + PAD + GAP + b.width <= W - MARGIN) { x = r.right + PAD + GAP; y = r.top; }
    else if (r.left - PAD - GAP - b.width >= MARGIN) { x = r.left - PAD - GAP - b.width; y = r.top; }
    else { x = (W - b.width) / 2; y = H - b.height - MARGIN; }
    return { ...hole, bx: Math.max(MARGIN, Math.min(x, W - b.width - MARGIN)), by: Math.max(MARGIN, Math.min(y, H - b.height - MARGIN)) };
  }
  // Between steps the outline travels on an ease-in-out curve (slow start, slow stop; longer trips take a little
  // longer). Meanwhile the bubble is hidden and appears beside the outline once it has arrived, so the eye follows
  // the outline, then reads. Within a step, the outline and bubble stay with an area that scrolls or moves.
  let trip = null;   // { from, start, dur } while travelling to a new step
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  function tick(now) {
    const want = wanted();
    if (want) {
      if (!cur) { cur = { ...want }; showBubble(); }
      else if (trip) {
        const p = reduce ? 1 : Math.min(1, (now - trip.start) / trip.dur), e = ease(p);
        for (const key of ['x', 'y', 'w', 'h', 'o']) cur[key] = trip.from[key] + (want[key] - trip.from[key]) * e;
        if (p >= 1) { trip = null; cur.bx = want.bx; cur.by = want.by; showBubble(); }
      } else cur = { ...want };
      Object.assign(hole.style, { left: cur.x + 'px', top: cur.y + 'px', width: Math.max(0, cur.w) + 'px', height: Math.max(0, cur.h) + 'px', opacity: cur.o });
      if (!trip) { bubble.style.left = want.bx + 'px'; bubble.style.top = want.by + 'px'; }
    }
    frame = requestAnimationFrame(tick);
  }
  function startTrip() {
    if (!cur) return;
    const want = wanted(); if (!want) return;
    const dist = Math.hypot(want.x - cur.x, want.y - cur.y) + Math.abs(want.w - cur.w) + Math.abs(want.h - cur.h);
    trip = { from: { ...cur }, start: performance.now(), dur: Math.max(380, Math.min(650, 340 + dist * 0.35)) };
    bubble.classList.remove('in'); bubble.classList.add('away');
  }
  function showBubble() { bubble.classList.remove('away'); bubble.classList.remove('in'); void bubble.offsetWidth; bubble.classList.add('in'); }
  const place = () => {};   // positions come from tick(); kept for the resize listener

  function render() {
    const s = steps[i];
    const shown = steps.filter(usable), k = shown.indexOf(s) + 1;
    const btn = (label, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = label; x.onclick = fn; return x; };
    const head = document.createElement('div'); head.className = 'tour-head';
    const count = document.createElement('span'); count.className = 'tour-count'; count.textContent = `${k} / ${shown.length}`;
    head.append(count, btn(t('tour.skip'), 'link tour-skip', () => end(true)));
    const h = document.createElement('h3'); h.textContent = s.title;
    const p = document.createElement('p'); p.textContent = typeof s.body === 'function' ? s.body() : s.body;
    const foot = document.createElement('div'); foot.className = 'tour-foot';
    const dots = document.createElement('div'); dots.className = 'tour-dots';
    shown.forEach((_, j) => { const d = document.createElement('span'); if (j === k - 1) d.className = 'on'; dots.append(d); });
    const nav = document.createElement('div'); nav.className = 'tour-nav';
    if (k > 1) nav.append(btn(t('tour.back'), 'tour-back', () => go(-1)));
    nav.append(btn(k === shown.length ? t('tour.done') : t('tour.next'), 'primary tour-next', () => go(1)));
    foot.append(dots, nav);
    bubble.replaceChildren(head, h, p, foot);
    bubble.querySelector('.tour-next').focus({ preventScroll: true });
  }

  function go(dir) {
    let j = i + dir;
    while (steps[j] && !usable(steps[j])) j += dir;
    if (j < 0) return;
    if (j >= steps.length) return end(false);
    i = j; clearInterval(poll);
    const s = steps[i];
    s.target()?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    onStep(s, i);
    render(); startTrip();
    // A target that appears later (e.g. a suggestion still being made): keep the light on it once it shows up.
    if (s.wait) poll = setInterval(() => { const n = s.wait(); if (visible(n)) { s.target = () => n; if (s.foundBody) s.body = s.foundBody; clearInterval(poll); render(); startTrip(); } }, 500);
  }

  function end(skipped) {
    clearInterval(poll); cancelAnimationFrame(frame);
    removeEventListener('resize', place); removeEventListener('keydown', key, true);
    root.classList.add('out'); setTimeout(() => root.remove(), 180);
    onEnd({ skipped });
  }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }
  addEventListener('resize', place);
  addEventListener('keydown', key, true);
  root.addEventListener('click', e => { if (e.target === root || e.target === hole) bubble.focus(); });   // clicks on the page are held while the guide is open
  go(1);
  frame = requestAnimationFrame(tick);
  return { end: () => end(true) };
}
