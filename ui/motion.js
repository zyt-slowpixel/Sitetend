// One set of motion rules for the whole UI: things open quickly and settle (ease-out),
// close a little faster than they opened (ease-in), and grow from / shrink back to whatever opened them.
export const EASE_OUT = 'cubic-bezier(.2,.9,.25,1)';
export const EASE_IN = 'cubic-bezier(.4,0,1,1)';
export const DUR = { pop: 180, popOut: 120, panel: 320, panelOut: 220, dialog: 220, dialogOut: 150, layout: 280, fadeOut: 110, fadeIn: 180 };

const mq = matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => mq.matches;
const run = (node, frames, ms, easing, extra = {}) => reduced() ? null : node.animate(frames, { duration: ms, easing, ...extra });
const stop = node => node.getAnimations().forEach(a => a.cancel());
const center = (r, base) => `${r.left + r.width / 2 - base.left}px ${r.top + r.height / 2 - base.top}px`;

// ---- menus: grow out of the button that opened them, fall back into it
/** A menu that would stick out of the window (a narrow window, a long translation) is moved back inside it. */
export function keepOnScreen(menu, gap = 8) {
  menu.style.translate = ''; menu.style.maxWidth = `calc(100vw - ${gap * 2}px)`;
  const r = menu.getBoundingClientRect();
  const shift = r.left < gap ? gap - r.left : r.right > innerWidth - gap ? innerWidth - gap - r.right : 0;
  if (shift) menu.style.translate = `${Math.round(shift)}px 0`;   // its own property: the open animation uses transform
}
export function popIn(menu, trigger) {
  const wasHidden = menu.hidden || menu.dataset.leaving;
  stop(menu); delete menu.dataset.leaving; menu.hidden = false;
  keepOnScreen(menu); requestAnimationFrame(() => keepOnScreen(menu));   // again once the page around it has settled
  if (!wasHidden) return;
  if (trigger) menu.style.transformOrigin = center(trigger.getBoundingClientRect(), menu.getBoundingClientRect());
  run(menu, [{ opacity: 0, transform: 'translateY(-4px) scale(.94)' }, { opacity: 1, transform: 'none' }], DUR.pop, EASE_OUT);
}
export function popOut(menu) {
  if (menu.hidden || menu.dataset.leaving) return;
  const a = run(menu, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], DUR.popOut, EASE_IN, { fill: 'forwards' });
  if (!a) { menu.hidden = true; return; }
  menu.dataset.leaving = '1';
  a.finished.then(() => { if (!menu.dataset.leaving) return; delete menu.dataset.leaving; menu.hidden = true; stop(menu); }).catch(() => {});
}

// ---- side panels: open out of the button's own rectangle (clip-path), close back into it
function insetOf(panel, trigger) {
  const p = panel.getBoundingClientRect(), g = trigger.getBoundingClientRect();
  const v = [g.top - p.top, p.right - g.right, p.bottom - g.bottom, g.left - p.left].map(n => Math.max(0, n) + 'px');
  return `inset(${v.join(' ')} round 10px)`;
}
// fully open: the clip reaches past the edges, so the panel's shadow is already there while it grows (no pop at the end)
const FULL = 'inset(-80px -80px -80px -80px round 0px)';
export function growFrom(panel, trigger) {
  const wasHidden = panel.hidden || panel.dataset.leaving;
  stop(panel); delete panel.dataset.leaving; panel.hidden = false;
  if (!wasHidden || !trigger) return;
  run(panel, [{ clipPath: insetOf(panel, trigger), opacity: .5 }, { clipPath: FULL, opacity: 1, offset: .7 }, { clipPath: FULL, opacity: 1 }], DUR.panel, EASE_OUT);
}
export function shrinkTo(panel, trigger) {
  if (panel.hidden || panel.dataset.leaving) return;
  const a = trigger && run(panel, [{ clipPath: FULL, opacity: 1 }, { clipPath: insetOf(panel, trigger), opacity: .3 }], DUR.panelOut, EASE_IN, { fill: 'forwards' });
  if (!a) { panel.hidden = true; return; }
  panel.dataset.leaving = '1';
  a.finished.then(() => { if (!panel.dataset.leaving) return; delete panel.dataset.leaving; panel.hidden = true; stop(panel); }).catch(() => {});
}
export function fadeShow(node) {
  const wasHidden = node.hidden || node.dataset.leaving;
  stop(node); delete node.dataset.leaving; node.hidden = false;
  if (wasHidden) run(node, [{ opacity: 0 }, { opacity: 1 }], DUR.panel, 'ease');
}
export function fadeHide(node, ms = DUR.panelOut) {
  if (node.hidden || node.dataset.leaving) return;
  const a = run(node, [{ opacity: 1 }, { opacity: 0 }], ms, 'ease', { fill: 'forwards' });
  if (!a) { node.hidden = true; return; }
  node.dataset.leaving = '1';
  a.finished.then(() => { if (!node.dataset.leaving) return; delete node.dataset.leaving; node.hidden = true; stop(node); }).catch(() => {});
}

// ---- dialogs: zoom in from the middle over a fading backdrop; leave a little faster
export function openDialog(d) {
  stop(d); d.showModal();
  run(d, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], DUR.dialog, EASE_OUT);
}
export function closeDialog(d, value = '') {
  if (!d.open || d.dataset.leaving) return;
  const a = run(d, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], DUR.dialogOut, EASE_IN, { fill: 'forwards' });
  d.classList.add('closing');
  const done = () => { delete d.dataset.leaving; d.classList.remove('closing'); stop(d); d.close(value); };
  if (!a) return done();
  d.dataset.leaving = '1'; a.finished.then(done, done);
}
/** Route a <dialog>'s own buttons and Escape through closeDialog so it always animates out. */
export function animateDialog(d) {
  d.addEventListener('cancel', e => { e.preventDefault(); closeDialog(d, 'cancel'); });
  d.querySelector('form[method=dialog]')?.addEventListener('submit', e => { e.preventDefault(); closeDialog(d, e.submitter?.value || ''); });
}
/** In-app replacement for window.confirm(): same zoom as the other dialogs, resolves true/false. */
export function confirmBox(text, { ok = 'OK', cancel = 'Cancel' } = {}) {
  return new Promise(resolve => {
    const d = document.createElement('dialog'); d.className = 'edit-dialog confirm-dialog';
    const f = document.createElement('form'); f.method = 'dialog';
    const p = document.createElement('p'); p.textContent = text;
    const btns = document.createElement('div'); btns.className = 'btns';
    const no = Object.assign(document.createElement('button'), { value: 'cancel', textContent: cancel });
    const yes = Object.assign(document.createElement('button'), { value: 'ok', textContent: ok, className: 'primary' });
    btns.append(no, yes); f.append(p, btns); d.append(f); document.body.append(d);
    animateDialog(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.addEventListener('click', e => { if (e.target === d) closeDialog(d, 'cancel'); });   // click on the backdrop
    openDialog(d); yes.focus();
  });
}

// ---- lists: when a re-render moves, grows or shrinks items, slide them from where they were (FLIP)
export function flip(container, render, key = 'key') {
  if (reduced() || !container.offsetParent) return render();
  const before = new Map([...container.children].filter(n => n.dataset[key]).map(n => [n.dataset[key], n.getBoundingClientRect()]));
  render();
  for (const n of container.children) {
    const k = n.dataset[key]; if (!k) continue;
    const old = before.get(k), now = n.getBoundingClientRect();
    if (!old) { if (before.size) n.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.layout, easing: EASE_OUT }); continue; }
    const dy = old.top - now.top, dh = old.height - now.height;
    if (Math.abs(dy) < 1 && Math.abs(dh) < 1) continue;
    const frames = [{ transform: `translateY(${dy}px)` }, { transform: 'none' }];
    if (Math.abs(dh) >= 1) { frames[0].height = old.height + 'px'; frames[1].height = now.height + 'px'; n.style.overflow = 'hidden'; }
    n.animate(frames, { duration: DUR.layout, easing: EASE_OUT }).finished.then(() => { n.style.overflow = ''; }, () => { n.style.overflow = ''; });
  }
}

// ---- tabs: old content fades down and out, new content fades in from just above
let swapping = null;
export async function crossfade(nodes, render) {
  const vis = nodes().filter(n => !n.hidden);
  if (reduced() || !vis.length) return render();
  const token = swapping = {};
  await Promise.all(vis.map(n => n.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: DUR.fadeOut, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {})));
  if (token !== swapping) return;
  vis.forEach(stop);
  render();
  nodes().filter(n => !n.hidden).forEach(n => n.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.fadeIn, easing: EASE_OUT }));
}
