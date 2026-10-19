// holds-fx.js — the feel of earning holds, everywhere in the app.
//
// Holds are earned where the studying happens — a tick in Homework, a step
// solved with ClimbAI, a focus session — not on the Crew screen. So the
// celebration happens there too: a "+20" pops where you clicked, holds fly to
// the counter beside Crew in the menu, the counter rolls up number by number,
// and each hold lands with a clink a little higher than the last. A big win
// ends with a short fanfare.
//
// The numbers come from the server (/crew/holds): the app shows what was
// really earned, never a guess. During a focus session the five-minute holds
// are shown as they happen and the server confirms them when it is saved.
//
// Sounds are made here with Web Audio — no files to load — and one switch in
// Settings turns them off. Less motion turns the flying off, not the numbers.
const HoldsFx = (() => {
  const $ = id => document.getElementById(id);
  const t = (k, v) => (window.t ? window.t(k, v) : k);
  const BACKEND = window.CLIMBY_BACKEND;
  const SEEN = 'climby-holds-seen:';       // shared with crew.js: one "last shown" per account
  const SOUND_KEY = 'climby-sounds';
  const COLORS = ['#ff5a5f', '#ffb703', '#2ec4b6', '#8b5cf6', '#3a86ff', '#f72585', '#06d6a0'];

  const calm = () => {
    const m = document.documentElement.getAttribute('data-motion');
    return m === 'off' || !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  // ---------------------------------------------------------------- sound
  let ctx = null;
  function soundOn() { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } }
  function audio() {
    if (!soundOn()) return null;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch { return null; }
  }

  // One bright "clink": two partials, a fast attack, a short ring.
  function note(freq, at, len = 0.16, vol = 0.12, type = 'triangle') {
    const a = audio();
    if (!a) return;
    const start = a.currentTime + at;
    [[freq, vol], [freq * 2.01, vol * 0.35]].forEach(([f, v]) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(v, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + len);
      o.connect(g).connect(a.destination);
      o.start(start);
      o.stop(start + len + 0.02);
    });
  }
  // the i-th hold of a run, each a step higher (a major scale, so it climbs)
  const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
  function clink(i = 0) { note(880 * Math.pow(2, SCALE[Math.min(i, SCALE.length - 1)] / 12), 0); }
  function fanfare() { [0, 4, 7, 12].forEach((s, i) => note(523.25 * Math.pow(2, s / 12), i * 0.09, 0.32, 0.1)); }
  function tick() { note(1760, 0, 0.04, 0.03, 'square'); }

  // ---------------------------------------------------------------- the counter
  let known = null;      // the total last shown
  let ahead = 0;         // shown during a focus session, not yet confirmed
  let shown = 0;         // what the counter displays right now

  function owner() { const u = window.Auth && Auth.getUser(); return u && u.id ? String(u.id) : null; }
  function loadSeen() { try { const o = owner(); const v = o && localStorage.getItem(SEEN + o); return v == null ? null : Number(v); } catch { return null; } }
  function saveSeen(n) { try { const o = owner(); if (o) localStorage.setItem(SEEN + o, String(n)); } catch { /* shown again */ } }

  function counterEl() {
    let el = $('holdsCounter');
    if (el) return el;
    const link = document.querySelector('.nav-link[data-view="crew"]');
    if (!link) return null;
    el = document.createElement('span');
    el.id = 'holdsCounter';
    el.className = 'holds-counter hidden';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<i class="holds-counter-dot" aria-hidden="true"></i><b>0</b>';
    link.appendChild(el);
    return el;
  }

  const fmt = n => Number(n).toLocaleString(window.I18n && I18n.get() === 'bg' ? 'bg-BG' : 'en-GB');

  function paint(n) {
    const el = counterEl();
    if (!el) return;
    shown = n;
    el.querySelector('b').textContent = fmt(n);
    el.classList.toggle('hidden', !(window.Auth && Auth.isLoggedIn()));
    el.setAttribute('aria-label', t('holds.counterAria', { n }));
  }

  // The number rolls up rather than jumping: fast at first, slowing at the end.
  let rolling = 0;
  function roll(to, ms = 1100) {
    const el = counterEl();
    if (!el) return;
    const from = shown;
    if (calm() || to <= from) { paint(to); return; }
    const run = ++rolling;
    const t0 = performance.now();
    let last = from;
    el.classList.add('is-rolling');
    const step = now => {
      if (run !== rolling) return;
      const k = Math.min(1, (now - t0) / ms);
      const v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (v !== last && (v - from) % Math.max(1, Math.round((to - from) / 12)) === 0) tick();
      last = v;
      paint(v);
      if (k < 1) requestAnimationFrame(step);
      else el.classList.remove('is-rolling');
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- the pop
  let lastPoint = null;  // where the person last clicked: that is where it happened
  document.addEventListener('pointerdown', e => { lastPoint = { x: e.clientX, y: e.clientY, at: Date.now() }; }, true);

  function from(anchor) {
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (lastPoint && Date.now() - lastPoint.at < 60000) return lastPoint;
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function holdSvg(i) {
    const shapes = [
      'M16 3c6 0 12 4 13 10 1 7-4 15-12 16-8 1-14-4-14-11C3 10 9 3 16 3z',
      'M6 9c3-5 11-7 17-4s7 11 4 16-10 9-16 6S3 14 6 9z',
      'M16 2c5 1 9 5 11 10s1 12-5 15-14 2-17-4S7 3 16 2z',
    ];
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="${shapes[i % 3]}" fill="${COLORS[i % COLORS.length]}"/>
      <circle cx="16" cy="16" r="3" fill="rgba(0,0,0,.35)"/><circle cx="12" cy="11" r="3" fill="rgba(255,255,255,.45)"/></svg>`;
  }

  // "+n" where it happened, holds flying to the counter, the counter rolling.
  function celebrate(n, anchor, target) {
    if (!(n > 0)) return;
    const p = from(anchor);
    const big = n >= 20;
    const plus = document.createElement('div');
    plus.className = 'holds-plus' + (big ? ' is-big' : '');
    plus.innerHTML = `${holdSvg(3)}<b>+${fmt(n)}</b>`;
    plus.style.left = p.x + 'px';
    plus.style.top = p.y + 'px';
    document.body.appendChild(plus);
    setTimeout(() => plus.remove(), 1700);

    const counter = counterEl();
    const end = counter && !counter.classList.contains('hidden') && counter.offsetParent ? counter.getBoundingClientRect() : null;
    const flyers = calm() || !end ? 0 : Math.min(10, Math.max(3, Math.round(n / 5)));
    if (!flyers) {
      clink(0);
      if (big) setTimeout(fanfare, 120);
      roll(target);
      return;
    }
    const ex = end.left + 12, ey = end.top + end.height / 2;
    const startAt = shown;
    let landed = 0;
    for (let i = 0; i < flyers; i++) {
      const el = document.createElement('div');
      el.className = 'holds-fly';
      el.innerHTML = holdSvg(i);
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      document.body.appendChild(el);
      const mx = (p.x + ex) / 2 + (Math.random() - 0.5) * 220;
      const my = Math.min(p.y, ey) - 80 - Math.random() * 120;
      el.animate([
        { transform: 'translate(-50%,-50%) scale(.3)', opacity: 0 },
        { transform: `translate(calc(${mx - p.x}px - 50%), calc(${my - p.y}px - 50%)) scale(1.3) rotate(${180 + i * 40}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(${ex - p.x}px - 50%), calc(${ey - p.y}px - 50%)) scale(.5) rotate(${360 + i * 70}deg)`, opacity: 1 },
      ], { duration: 820 + i * 70, delay: i * 85, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' }).onfinish = () => {
        el.remove();
        clink(landed);
        landed++;
        // the counter climbs a share with every hold that lands
        roll(Math.round(startAt + (target - startAt) * (landed / flyers)), 260);
        counter.classList.remove('is-bump'); void counter.offsetWidth; counter.classList.add('is-bump');
        if (landed === flyers && big) setTimeout(fanfare, 80);
      };
    }
  }

  // ---------------------------------------------------------------- syncing
  let syncing = null;
  async function sync(opts = {}) {
    if (!window.Auth || !Auth.isLoggedIn()) { paint(0); return; }
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const res = await Net.fetch(`${BACKEND}/crew/holds`, { headers: { Authorization: `Bearer ${Auth.getToken()}` } });
        if (!res.ok) return;
        const { total } = await res.json();
        const before = known === null ? loadSeen() : known;
        known = total;
        saveSeen(total);
        if (before === null || opts.silent) { if (shown !== total) paint(total); return; }
        const gained = total - before - ahead;
        ahead = Math.max(0, ahead - Math.max(0, total - before));
        if (gained > 0) celebrate(gained, opts.anchor, total);
        else roll(total);
      } catch { /* the counter waits for the next one */ } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  // A focus session: five holds every full five minutes, shown as they come.
  // The server pays them when the session is saved; sync() then counts them
  // as already shown.
  let focusShown = 0;
  setInterval(() => {
    const f = window.Focus;
    if (!f || !f.isRunning || !f.isRunning() || !window.Auth || !Auth.isLoggedIn()) { focusShown = 0; return; }
    const blocks = Math.floor(f.activeMs() / 300000);
    if (blocks > focusShown && focusShown * 5 < 120) {
      const n = (blocks - focusShown) * 5;
      focusShown = blocks;
      ahead += n;
      const anchor = document.querySelector('#focusRunning:not(.hidden) .focus-preview') || document.getElementById('focusBadge');
      celebrate(n, anchor, shown + n);
    }
  }, 5000);

  function init() {
    sync({ silent: true });
    window.addEventListener('climby:auth-changed', () => { known = null; ahead = 0; sync({ silent: true }); });
    window.addEventListener('climby:lang-changed', () => paint(shown));
    // the moments that may have earned something
    ['climby:activity', 'climby:tasks-changed', 'climby:holds-maybe'].forEach(ev =>
      window.addEventListener(ev, () => setTimeout(() => sync(), 250)));
    const sw = $('soundsOn');
    if (sw) {
      sw.checked = soundOn();
      sw.addEventListener('change', () => {
        try { localStorage.setItem(SOUND_KEY, sw.checked ? 'on' : 'off'); } catch { /* this visit */ }
        if (sw.checked) clink(4);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  return { sync, celebrate, clink, fanfare, roll, soundOn, markSeen: n => { known = n; saveSeen(n); paint(n); } };
})();

window.HoldsFx = HoldsFx;
