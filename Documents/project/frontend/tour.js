// tour.js — a spotlight walk through the real interface.
//
// The onboarding cards described the app in the abstract: three sentences on a
// blank card, gone before anything had a shape. This points at the actual
// buttons instead. Each stop dims everything except one element and puts a
// short card beside it, and moving between stops switches screens the way the
// person will, so what they see is what they will use.
//
// It runs once, after the onboarding questions, and can be replayed from
// Settings. Anything it cannot find on screen — the sidebar on a narrow phone,
// a role's screen the person does not have — is skipped, not shown broken.
const Tour = (() => {
  const $ = id => document.getElementById(id);
  const SEEN_KEY = 'climby-tour-seen';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Each stop: what to point at, which screen it lives on, and the two strings.
  // Order is the order a person meets things: the AI first, because it is the
  // reason they came; the rest in the order of the sidebar.
  const STOPS = [
    { view: 'tutor',     target: '.nav-link[data-view="tutor"]',     title: 'tour.aiTitle',      body: 'tour.aiBody' },
    { view: 'tutor',     target: '.entry-choices',                   title: 'tour.entryTitle',   body: 'tour.entryBody' },
    { view: 'focus',     target: '.nav-link[data-view="focus"]',     title: 'tour.focusTitle',   body: 'tour.focusBody' },
    { view: 'checklist', target: '.nav-link[data-view="checklist"]', title: 'tour.routeTitle',   body: 'tour.routeBody' },
    { view: 'history',   target: '.nav-link[data-view="history"]',   title: 'tour.historyTitle', body: 'tour.historyBody' },
    { view: 'family',    target: '.nav-link[data-view="family"]',    title: 'tour.familyTitle',  body: 'tour.familyBody' },
    { view: 'tutor',     target: '#view-tutor .help-toggle',         title: 'tour.helpTitle',    body: 'tour.helpBody' },
    { view: 'tutor',     target: '#settingsMenuBtn',                 title: 'tour.doneTitle',    body: 'tour.doneBody', openMenu: true },
  ];

  let index = -1;
  let stops = [];     // the STOPS that can actually be shown right now
  let root, dim, hole, card;
  let onResize = null;

  function t(key) { return window.t ? window.t(key) : key; }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') return false;
    // A drawer slid off-screen still has a size; it is not visible.
    return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  }

  // On a phone the sidebar is a drawer. A stop that points into it opens it
  // first; every other stop closes it, so the card is never under the drawer.
  function settleSidebar(el) {
    if (!window.Nav) return;
    if (el && el.closest('.sidebar')) Nav.openSidebar(); else Nav.closeSidebar();
  }

  // Three layers: a full-screen dim with a hole cut out of it, a ring drawn on
  // the hole's edge, and the card. The dim and the ring are separate because a
  // clip-path cannot carry a glow.
  function build() {
    root = document.createElement('div');
    root.id = 'tour';
    root.className = 'tour hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML =
      '<div class="tour-dim" aria-hidden="true"></div>' +
      '<div class="tour-hole" aria-hidden="true"></div>' +
      '<div class="tour-card">' +
        '<p class="tour-step"></p>' +
        '<h3 class="tour-title"></h3>' +
        '<p class="tour-body"></p>' +
        '<div class="tour-actions">' +
          '<button type="button" class="tour-skip" data-i18n="tour.skip"></button>' +
          '<span class="tour-spacer"></span>' +
          '<button type="button" class="tour-back" data-i18n="tour.back"></button>' +
          '<button type="button" class="tour-next btn-primary" data-i18n="tour.next"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    dim = root.querySelector('.tour-dim');
    hole = root.querySelector('.tour-hole');
    card = root.querySelector('.tour-card');
    root.querySelector('.tour-skip').addEventListener('click', finish);
    root.querySelector('.tour-back').addEventListener('click', () => go(index - 1, -1));
    root.querySelector('.tour-next').addEventListener('click', () => go(index + 1, 1));
    // Clicking the dim, away from the card, is "skip" — the same as pressing
    // Escape. Nobody should be trapped by a tutorial.
    root.addEventListener('click', e => { if (e.target === root) finish(); });
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2;
    hole.style.left = x + 'px';
    hole.style.top = y + 'px';
    hole.style.width = w + 'px';
    hole.style.height = h + 'px';
    // The dim is a full-screen layer with a rectangular hole cut by clip-path:
    // outer rectangle, then the hole wound the other way. A huge box-shadow did
    // the same job on paper and was silently clamped by the renderer.
    const vw = window.innerWidth, vh = window.innerHeight;
    dim.style.clipPath = `polygon(evenodd, 0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px, 0 0, ` +
      `${x}px ${y}px, ${x}px ${y + h}px, ${x + w}px ${y + h}px, ${x + w}px ${y}px, ${x}px ${y}px)`;

    // The card goes to the right of the target when there is room, otherwise
    // below it; and never off the bottom of the screen.
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let left, top;
    if (r.right + 20 + cw <= vw) {
      left = r.right + 20;
      top = r.top;
    } else {
      left = Math.max(12, Math.min(r.left, vw - cw - 12));
      top = r.bottom + 16;
    }
    top = Math.max(12, Math.min(top, vh - ch - 12));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function render() {
    const stop = stops[index];
    const el = document.querySelector(stop.target);
    root.querySelector('.tour-step').textContent = (index + 1) + ' / ' + stops.length;
    root.querySelector('.tour-title').textContent = t(stop.title);
    root.querySelector('.tour-body').textContent = t(stop.body);
    root.querySelector('.tour-back').disabled = index === 0;
    root.querySelector('.tour-next').textContent = t(index === stops.length - 1 ? 'tour.finish' : 'tour.next');
    root.querySelector('.tour-skip').textContent = t('tour.skip');
    root.querySelector('.tour-back').textContent = t('tour.back');
    // The target may have been scrolled away by the screen switch.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    place(el);
  }

  // Screens switch with transitions, and a target measured mid-transition can
  // read as off-screen. This is how long we give the layout to settle before
  // trusting a measurement — the longest transition in style.css is 0.2s.
  const SETTLE_MS = 260;
  let pending = 0;   // which go() is the current one; older ones must not act

  function go(i, dir) {
    if (i < 0) return;
    if (i >= stops.length) { finish(); return; }
    dir = dir || 1;
    index = i;
    const stop = stops[index];
    if (window.Nav && stop.view) Nav.activate(stop.view);
    settleSidebar(document.querySelector(stop.target));
    const mine = ++pending;
    setTimeout(() => {
      if (mine !== pending) return;   // a newer go() has taken over
      const el = document.querySelector(stop.target);
      // The direction is passed in, never inferred: inferring it from state
      // that another call may have changed is how a tour walks backwards.
      if (!visible(el)) { go(i + dir, dir); return; }
      render();
    }, SETTLE_MS);
  }

  function start() {
    if (!root) build();
    root.classList.remove('hidden');
    document.body.classList.add('tour-open');
    // Decide first which stops exist for this person: a parent has no Ascent, a
    // phone's sidebar is a drawer. Deciding per stop mid-tour would leave gaps in
    // the count ("3 of 8" followed by "6 of 8"). Each candidate gets its screen
    // switched and a moment to settle before it is measured — measured at once,
    // mid-transition, half of them read as off-screen and vanish from the tour.
    const kept = [];
    const consider = (n) => {
      if (n >= STOPS.length) {
        settleSidebar(null);
        stops = kept;
        if (!stops.length) { finish(); return; }
        onResize = () => { if (index >= 0) render(); };
        window.addEventListener('resize', onResize);
        go(0, 1);
        return;
      }
      const s = STOPS[n];
      if (window.Nav && s.view) Nav.activate(s.view);
      const el = document.querySelector(s.target);
      settleSidebar(el);
      setTimeout(() => {
        if (visible(document.querySelector(s.target))) kept.push(s);
        consider(n + 1);
      }, SETTLE_MS);
    };
    consider(0);
  }

  function finish() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* it will simply show again */ }
    if (root) root.classList.add('hidden');
    document.body.classList.remove('tour-open');
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    index = -1;
    if (window.Nav) { Nav.closeSidebar(); Nav.activate('tutor'); }
  }

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
  }

  function maybeStart() {
    if (seen()) return;
    // Not on top of the sign-in gate or the onboarding questions.
    const gate = $('entryGate'), onboarding = $('onboarding');
    if ((gate && !gate.classList.contains('hidden')) ||
        (onboarding && !onboarding.classList.contains('hidden'))) return;
    start();
  }

  function init() {
    document.addEventListener('keydown', e => {
      if (!root || root.classList.contains('hidden')) return;
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(index + 1, 1);
      else if (e.key === 'ArrowLeft') go(index - 1, -1);
    });
    window.addEventListener('climby:lang-changed', () => { if (index >= 0) render(); });
    // The onboarding questions come first; the tour starts when they close.
    window.addEventListener('climby:onboarding-done', maybeStart);
    // ...and for someone who answered them in an earlier version, when the
    // sign-in gate closes.
    window.addEventListener('climby:entry-gate-closed', () => setTimeout(maybeStart, 400));
    const replay = $('tourReplayBtn');
    if (replay) replay.addEventListener('click', () => {
      const overlay = $('settingsOverlay');
      if (overlay) overlay.classList.add('hidden');
      start();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { start, finish };
})();

window.Tour = Tour;
