// crew.js — the Crew screen: you and your friends on one mountain.
//
// Everyone stands on the trail at the height of the holds they earned this
// week; whoever is studying right now glows. Holds are the currency (the grips
// on a climbing wall): earned by studying, spent later on the mountain itself.
//
// Signed in, it is the real thing (crew.py): your friends, your holds, who is
// studying right now. Signed out, the same screen shows made-up people and
// says so ("Preview"), so the idea can be seen before an account exists.
const Crew = (() => {
  const $ = id => document.getElementById(id);
  const t = (k, v) => (window.t ? window.t(k, v) : k);
  const calm = () => {
    const m = document.documentElement.getAttribute('data-motion');
    return m === 'off' || !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  // ---------------------------------------------------------------- holds
  // Climbing holds: round, lumpy, bright, each with its bolt hole.
  const HOLD_SHAPES = [
    'M16 3c6 0 12 4 13 10 1 7-4 15-12 16-8 1-14-4-14-11C3 10 9 3 16 3z',
    'M6 9c3-5 11-7 17-4s7 11 4 16-10 9-16 6S3 14 6 9z',
    'M16 2c5 1 9 5 11 10s1 12-5 15-14 2-17-4S7 3 16 2z',
    'M9 5c5-3 13-2 17 3s3 13-2 17-14 3-18-2-2-15 3-18z',
  ];
  const HOLD_COLORS = ['#ff5a5f', '#ffb703', '#2ec4b6', '#8b5cf6', '#3a86ff', '#f72585', '#06d6a0'];

  function holdSvg(i = 0, color) {
    const shape = HOLD_SHAPES[i % HOLD_SHAPES.length];
    const c = color || HOLD_COLORS[i % HOLD_COLORS.length];
    return `<svg class="crew-hold" viewBox="0 0 32 32" aria-hidden="true">
      <path d="${shape}" fill="${c}"/>
      <path d="${shape}" fill="url(#crewHoldShine)" opacity=".55"/>
      <circle cx="16" cy="16" r="3.2" fill="rgba(0,0,0,.35)"/>
      <circle cx="16" cy="16" r="1.6" fill="rgba(255,255,255,.55)"/>
    </svg>`;
  }

  // ---------------------------------------------------------------- people
  const GRADS = [
    ['#8b5cf6', '#ec4899'], ['#06b6d4', '#3b82f6'], ['#f59e0b', '#ef4444'], ['#10b981', '#06b6d4'],
    ['#f472b6', '#a855f7'], ['#84cc16', '#22c55e'], ['#f97316', '#eab308'], ['#6366f1', '#22d3ee'],
  ];
  const grad = i => `linear-gradient(135deg, ${GRADS[i % GRADS.length][0]}, ${GRADS[i % GRADS.length][1]})`;

  function demo() {
    const u = (window.Auth && Auth.getUser()) || {};
    return {
      me: { id: 'me', name: u.display_name || t('crew.you'), username: u.username || 'you', grade: u.grade || 8,
            holdsWeek: 24, holdsTotal: 318, streak: 5, photo: window.ProfilePhoto ? ProfilePhoto.get() : null, hue: 0 },
      friends: [
        { id: 'f1', name: 'Ana', username: 'ana.k', grade: 8, holdsWeek: 31, holdsTotal: 412, streak: 9, live: true, liveMin: 42, mutual: 4, groups: ['g1'], hue: 1 },
        { id: 'f2', name: 'Ivo', username: 'ivo_08', grade: 8, holdsWeek: 19, holdsTotal: 260, streak: 3, mutual: 2, groups: ['g1'], hue: 2 },
        { id: 'f3', name: 'Mila', username: 'milaaa', grade: 9, holdsWeek: 27, holdsTotal: 377, streak: 12, live: true, liveMin: 15, mutual: 5, groups: ['g2'], hue: 3 },
        { id: 'f4', name: 'Dani', username: 'dani.p', grade: 7, holdsWeek: 11, holdsTotal: 140, streak: 1, mutual: 1, groups: ['g2'], hue: 4 },
        { id: 'f5', name: 'Niya', username: 'niya', grade: 8, holdsWeek: 22, holdsTotal: 301, streak: 6, mutual: 3, groups: ['g1'], hue: 5 },
        { id: 'f6', name: 'Krasi', username: 'krasi9', grade: 9, holdsWeek: 36, holdsTotal: 520, streak: 15, mutual: 2, groups: ['g2'], hue: 6 },
        { id: 'f7', name: 'Sisi', username: 'sisi.m', grade: 8, holdsWeek: 7, holdsTotal: 88, streak: 2, mutual: 3, groups: [], hue: 7 },
      ],
      // Groups don't exist on the server yet, so the preview doesn't promise
      // them either. The drawing code below stays for when they do:
      // [{ id: 'g1', name: '8B Maths', members: ['f1', 'f2', 'f5'] }, ...]
      groups: [],
      suggested: [
        { id: 's1', name: 'Petar', username: 'petar.v', grade: 8, mutual: 3, hue: 2 },
        { id: 's2', name: 'Gabi', username: 'gabi_g', grade: 8, mutual: 2, hue: 4 },
        { id: 's3', name: 'Teo', username: 'teo.d', grade: 9, mutual: 1, hue: 6 },
        { id: 's4', name: 'Rada', username: 'rada', grade: 7, mutual: 0, hue: 1 },
      ],
    };
  }

  let data = null;
  let built = false;
  let earnedShown = false;
  let mode = 'demo';          // 'demo' (signed out) | 'live' (the server's data)
  let loadSeq = 0;
  const BACKEND = window.CLIMBY_BACKEND;

  // One call to the server. Never throws: { ok, status, data }.
  async function api(path, options = {}) {
    const token = window.Auth && Auth.getToken();
    if (!token) return { ok: false, status: 401, data: {} };
    let res;
    try {
      res = await Net.fetch(BACKEND + path, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch {
      return { ok: false, status: 0, data: {} };
    }
    if (res.status === 401) { Auth.logout(); return { ok: false, status: 401, data: {} }; }
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: body };
  }

  function detail(r) {
    const d = r && r.data && r.data.detail;
    if (typeof d === 'string') return d;
    return r && r.status === 0 ? t('crew.offline') : t('crew.error');
  }

  // A photo from the server goes into a style attribute: only a real image data URL may.
  const PHOTO = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  const safePhoto = v => (typeof v === 'string' && PHOTO.test(v) ? v : null);

  // A colour per person that stays theirs: from the username, not the order.
  function hueOf(name) {
    let h = 0;
    for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % GRADS.length;
  }

  // One person as the server sends them, in the shape the screen draws.
  const person = p => ({
    id: p.username, name: p.name, username: p.username, grade: p.grade,
    holdsWeek: p.holds_week || 0, holdsTotal: p.holds_total || 0, streak: p.streak || 0,
    live: !!p.live, liveMin: p.live_minutes || 0, mutual: p.mutual || 0,
    photo: safePhoto(p.avatar), hue: hueOf(p.username), request: p.request || null,
  });

  function fromApi(d) {
    const me = person(d.me);
    me.id = 'me';
    if (!me.photo && window.ProfilePhoto) me.photo = safePhoto(ProfilePhoto.get());
    return {
      me,
      friends: (d.friends || []).map(person),
      incoming: (d.incoming || []).map(person),
      outgoing: new Set(d.outgoing || []),
      suggested: (d.suggested || []).map(person),
      groups: [],
    };
  }

  // How many holds this device last showed, per account: the difference is
  // what flies into the counter next time.
  const SEEN = 'climby-holds-seen:';
  function seenKey() { const u = window.Auth && Auth.getUser(); return u && u.id ? SEEN + u.id : null; }
  function seen() { try { const k = seenKey(); const v = k && localStorage.getItem(k); return v === null || v === undefined ? null : Number(v); } catch { return null; } }
  function remember(n) { try { const k = seenKey(); if (k) localStorage.setItem(k, String(n)); } catch { /* shown again next time */ } }
  let headlineTimer = null;
  let headlineIndex = 0;
  let cameFrom = null;

  const initial = p => (p.name || '?').trim().charAt(0).toUpperCase();
  function avatarStyle(p) {
    if (safePhoto(p.photo)) return `background-image:url("${p.photo}")`;
    return `--avatar-bg:${grad(p.hue || 0)}`;
  }
  function avatarHtml(p, extra = '') {
    return `<span class="crew-avatar" style='${avatarStyle(p)}'${extra}>${safePhoto(p.photo) ? '' : esc(initial(p))}</span>`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------- the ground
  // One coordinate frame, 1000 × 700, stretched to the screen: the ridge, the
  // trail and the bubbles all live in it, so a bubble always sits on the trail.
  const TRAIL = 'M150 560 C260 530 380 560 460 525 S640 495 615 445 S470 410 505 370 S650 335 628 290 S548 230 592 192 S636 138 642 112';
  const RIDGE_FAR = 'M0 430 L120 330 L230 380 L380 230 L500 300 L640 170 L770 270 L880 200 L1000 300 L1000 700 L0 700Z';
  const RIDGE_MID = 'M0 600 L130 520 L250 560 L400 420 L480 450 L560 260 L642 96 L720 230 L800 300 L900 280 L1000 380 L1000 700 L0 700Z';
  const SNOW = 'M642 96 L606 168 L626 160 L642 178 L660 158 L684 172 Z';

  function topo() {
    // contour lines around the summit, a little wobbly, like a map
    const paths = [];
    for (let k = 1; k <= 13; k++) {
      const r = k * 62;
      let d = '';
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const w = 1 + 0.09 * Math.sin(3 * a + k * 0.7) + 0.05 * Math.sin(5 * a - k);
        const x = 640 + Math.cos(a) * r * w * 1.25;
        const y = 150 + Math.sin(a) * r * w * 0.8;
        d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      paths.push(`<path d="${d}Z"/>`);
    }
    return paths.join('');
  }

  function build() {
    const root = $('crewStage');
    root.innerHTML = `
      <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
        <radialGradient id="crewHoldShine" cx="35%" cy="28%" r="60%"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>
      </defs></svg>
      <div class="crew-layer crew-topo" data-depth="4"><svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice">${topo()}</svg></div>
      <div class="crew-layer" data-depth="-10"><svg viewBox="0 0 1000 700" preserveAspectRatio="none"><path class="crew-ridge-far" d="${RIDGE_FAR}"/></svg></div>
      <div class="crew-layer crew-world" data-depth="-20">
        <div class="crew-trail"><svg viewBox="0 0 1000 700" preserveAspectRatio="none">
          <path class="crew-ridge-mid" d="${RIDGE_MID}"/>
          <path class="crew-snow" d="${SNOW}"/>
          <path class="crew-trail-glow" d="${TRAIL}"/>
          <path id="crewTrailPath" class="crew-trail-line" d="${TRAIL}"/>
        </svg></div>
        <div class="crew-flag" style="left:64.2%;top:15.7%"><svg viewBox="0 0 44 54" aria-hidden="true">
          <rect x="4" y="4" width="3" height="48" rx="1.5" fill="#fff"/>
          <path class="crew-flag-cloth" d="M7 6 C18 2 26 12 40 7 L40 25 C26 30 18 20 7 24Z" fill="url(#crewFlagGrad)"/>
          <defs><linearGradient id="crewFlagGrad" x1="0" x2="1"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
        </svg></div>
        <div id="crewBubbles" class="crew-bubbles"></div>
      </div>
      <div class="crew-hud">
        <h1 id="crewHeadline" class="crew-headline" aria-live="polite"></h1>
        <div id="crewWeek" class="crew-week">
          <span class="crew-pill is-dark" id="crewWeekPill"></span>
        </div>
        <button id="crewWallet" class="crew-wallet" type="button">
          ${holdSvg(3)}<span id="crewWalletCount">0</span><small data-i18n="crew.holds">${esc(t('crew.holds'))}</small>
        </button>
        <span class="crew-preview-tag" data-i18n="crew.preview">${esc(t('crew.preview'))}</span>
        <div class="crew-dock">
          <button id="crewSearchBtn" class="crew-dock-btn" type="button" data-i18n-aria="crew.search" aria-label="${esc(t('crew.search'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
          </button>
          <span class="crew-holo-wrap"><span id="crewAddBadge" class="crew-badge hidden"></span>
          <button id="crewAddBtn" class="crew-holo" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            <span data-i18n="crew.addFriend">${esc(t('crew.addFriend'))}</span>
          </button></span>
          <button id="crewMeBtn" class="crew-dock-btn" type="button" data-i18n-aria="crew.myProfile" aria-label="${esc(t('crew.myProfile'))}"></button>
        </div>
      </div>
      <div id="crewCardWrap" class="crew-card-wrap" aria-hidden="true">
        <div id="crewCard" class="crew-card" role="dialog" aria-modal="true" aria-labelledby="crewCardTitle"></div>
      </div>`;

    $('crewWallet').addEventListener('click', () => openWallet());
    $('crewSearchBtn').addEventListener('click', () => openSearch());
    $('crewAddBtn').addEventListener('click', () => openSearch());
    $('crewMeBtn').addEventListener('click', () => openPerson(data.me));
    $('crewCardWrap').addEventListener('click', e => { if (e.target === $('crewCardWrap')) closeCard(); });
    // On the document, not the stage: a list that redraws under the pointer
    // takes the focus with it, and Escape must still close the card.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('crewCardWrap').classList.contains('is-open')) { e.stopPropagation(); closeCard(); }
    }, true);
    parallax(root);
    built = true;
  }

  // ---------------------------------------------------------------- parallax
  function parallax(root) {
    if (calm()) return;
    let raf = 0, nx = 0, ny = 0;
    const layers = [...root.querySelectorAll('.crew-layer')];
    const apply = () => {
      raf = 0;
      layers.forEach(l => {
        const d = Number(l.dataset.depth || 0);
        l.style.transform = `translate3d(${(nx * d).toFixed(1)}px, ${(ny * d * 0.6).toFixed(1)}px, 0)`;
      });
    };
    root.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const r = root.getBoundingClientRect();
      nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    root.addEventListener('pointerleave', () => { nx = 0; ny = 0; if (!raf) raf = requestAnimationFrame(apply); });
  }

  // ---------------------------------------------------------------- render
  // walletFrom: what the counter shows before the holds fly in
  function render(d, walletFrom) {
    data = d;
    if (!built) build();
    const host = $('crewBubbles');
    host.innerHTML = '';
    const path = $('crewTrailPath');
    const len = path.getTotalLength();
    const everyone = [data.me, ...data.friends].sort((a, b) => a.holdsWeek - b.holdsWeek);
    const max = Math.max(...everyone.map(p => p.holdsWeek), 1);
    const stage = $('crewStage').getBoundingClientRect();
    const narrow0 = stage.width < 700;
    $('crewStage').classList.toggle('is-narrow', narrow0);
    // the bubbles live in the world's frame, which on a phone is shorter than the stage
    const world = $('crewStage').querySelector('.crew-world').getBoundingClientRect();
    const aspect = world.width && world.height ? world.width / world.height : 1.4;
    const placed = [];

    everyone.forEach((p, i) => {
      const f = 0.05 + 0.9 * (p.holdsWeek / max);
      const pt = path.getPointAtLength(f * len);
      let x = pt.x / 10, y = pt.y / 7;           // in % of the stage
      // never on top of each other: step aside, alternately left and right
      // Measured in pixels: one bubble and its label need about this much room.
      const W = world.width || 1000, H = world.height || 700;
      const rx = (narrow0 ? 64 : 84), ry = (narrow0 ? 88 : 104);
      const clash = (cx, cy) => placed.some(q => ((q.x - cx) * W / 100 / rx) ** 2 + ((q.y - cy) * H / 100 / ry) ** 2 < 1);
      const baseX = x;
      for (const dx of [0, 1, -1, 2, -2, 3, -3]) {
        // keep the whole bubble on screen (on a phone the world is wider than it)
        const lo = narrow0 ? 21 : 8, hi = narrow0 ? 79 : 92;
        x = Math.min(hi, Math.max(lo, baseX + dx * rx * 1.05 / W * 100));
        if (!clash(x, y)) break;
      }
      placed.push({ x, y });

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crew-bubble' + (p.id === 'me' ? ' is-me' : '') + (p.live ? ' is-live' : '');
      b.style.left = x + '%';
      b.style.top = y + '%';
      b.style.setProperty('--delay', (0.15 + i * 0.09).toFixed(2) + 's');
      b.style.animationDuration = `0.6s, ${4 + (i % 4) * 0.6}s`;
      const label = p.id === 'me' ? t('crew.you') : p.name;
      b.setAttribute('aria-label', t(p.live ? 'crew.bubbleLive' : 'crew.bubble', { name: label, n: p.holdsWeek }));
      b.innerHTML =
        (p.live ? '<span class="crew-ripple"></span><span class="crew-ripple"></span><span class="crew-ripple"></span>' : '') +
        avatarHtml(p) +
        (p.live ? `<span class="crew-live-tag"><i></i>${esc(t('crew.live'))}</span>` : '') +
        `<span class="crew-label">${holdSvg(i)}<b>${p.holdsWeek}</b> ${esc(label)}</span>`;
      b.addEventListener('click', () => openPerson(p));
      host.appendChild(b);
      if (p.id === 'me') b.id = 'crewMe';
    });

    // the groups, as clusters beside the mountain
    // On a wide screen the groups float beside the mountain; on a phone there
    // is no beside, so they sit in the row under the headline instead.
    const narrow = stage.width < 700;
    const row = $('crewWeek');
    row.querySelectorAll('.crew-group').forEach(el => el.remove());
    const tag = $('crewStage').querySelector('.crew-preview-tag');
    (narrow ? row : $('crewStage').querySelector('.crew-hud')).appendChild(tag);
    tag.classList.toggle('hidden', mode !== 'demo');
    $('crewStage').classList.toggle('is-narrow', narrow);
    const spots = [{ x: 13, y: 46 }, { x: 86, y: 58 }];
    data.groups.slice(0, spots.length).forEach((g, i) => {
      const people = g.members.map(id => data.friends.find(f => f.id === id)).filter(Boolean);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'crew-group' + (narrow ? ' is-docked' : '');
      if (!narrow) {
        el.style.left = spots[i].x + '%';
        el.style.top = spots[i].y + '%';
      }
      el.style.setProperty('--delay', (0.9 + i * 0.15) + 's');
      el.setAttribute('aria-label', t('crew.groupAria', { name: g.name, n: people.length }));
      el.innerHTML = people.slice(0, 3).map(p => `<span class="crew-mini" style='--avatar-bg:${grad(p.hue)}'>${esc(initial(p))}</span>`).join('') +
        `<span class="crew-group-count">${people.length}</span><span class="crew-group-name">${esc(g.name)}</span>`;
      el.addEventListener('click', () => openGroup(g, people));
      (narrow ? row : host).appendChild(el);
    });

    const me = $('crewMeBtn');
    const myPhoto = safePhoto(data.me.photo);
    me.style.cssText = myPhoto ? `background-image:url("${myPhoto}")` : `background:${grad(data.me.hue || 0)};color:#fff`;
    me.textContent = myPhoto ? '' : initial(data.me);
    $('crewWalletCount').textContent = String(typeof walletFrom === 'number' ? walletFrom : data.me.holdsTotal);
    const waiting = (data.incoming || []).length;
    $('crewAddBadge').textContent = String(waiting);
    $('crewAddBadge').classList.toggle('hidden', !waiting);
    $('crewWeekPill').innerHTML = `${holdSvg(1)}${esc(t('crew.weekPill', { n: data.me.holdsWeek }))}`;
    startHeadlines();
  }

  // ---------------------------------------------------------------- headlines
  function headlines() {
    const me = data.me;
    const all = [me, ...data.friends].sort((a, b) => b.holdsWeek - a.holdsWeek);
    const top = all[0];
    const ahead = all.filter(p => p.holdsWeek > me.holdsWeek).pop();   // the one just above me
    const live = data.friends.filter(f => f.live);
    const out = [];
    const waiting = (data.incoming || []).length;
    if (waiting) out.push([t(waiting === 1 ? 'crew.hlAskOne1' : 'crew.hlAsk1', { n: waiting, name: data.incoming[0].name }), t('crew.hlAsk2')]);
    // nothing yet is not a number to show anyone: it is an invitation
    const week = me.holdsWeek ? [t('crew.hlWeek1', { n: me.holdsWeek }), t('crew.hlWeek2')]
                              : [t('crew.hlFirst1'), t('crew.hlFirst2')];
    if (!data.friends.length) {
      out.push([t('crew.hlAlone1'), t('crew.hlAlone2')]);
      out.push(week);
      return out;
    }
    if (top.id === 'me') out.push([t('crew.hlTop1'), t('crew.hlTop2')]);
    else if (ahead) out.push([t('crew.hlAhead1', { name: ahead.name }), t('crew.hlAhead2', { n: ahead.holdsWeek - me.holdsWeek })]);
    if (live.length) out.push([t(live.length === 1 ? 'crew.hlLiveOne1' : 'crew.hlLive1', { n: live.length, name: live[0].name }), t('crew.hlLive2')]);
    out.push(week);
    out.push([t('crew.hlSummit1', { name: top.id === 'me' ? t('crew.you') : top.name }), t('crew.hlSummit2')]);
    return out;
  }

  function showHeadline(i, animate) {
    const h = $('crewHeadline');
    const list = headlines();
    const [a, b] = list[i % list.length];
    const put = () => {
      h.innerHTML = `<span class="crew-headline-line">${esc(a)}</span><span class="crew-headline-line crew-hl-accent">${esc(b)}</span>`;
      h.classList.remove('is-swapping');
      h.classList.remove('is-in'); void h.offsetWidth; h.classList.add('is-in');
    };
    if (!animate || calm()) { put(); return; }
    h.classList.add('is-swapping');
    setTimeout(put, 320);
  }

  function startHeadlines() {
    stopHeadlines();
    headlineIndex = 0;
    showHeadline(0, false);
    headlineTimer = setInterval(() => showHeadline(++headlineIndex, true), 5200);
  }
  function stopHeadlines() { if (headlineTimer) clearInterval(headlineTimer); headlineTimer = null; }

  // ---------------------------------------------------------------- earning
  // The first visit plays what earning looks like: three holds fly from your
  // bubble into the counter, which jumps.
  function earn(n, from, finalTotal) {
    const stage = $('crewStage');
    const wallet = $('crewWallet');
    const count = $('crewWalletCount');
    const s = stage.getBoundingClientRect();
    const src = (from || $('crewMe') || wallet).getBoundingClientRect();
    const dst = wallet.querySelector('.crew-hold').getBoundingClientRect();
    const x0 = src.left + src.width / 2 - s.left, y0 = src.top + src.height / 2 - s.top;
    const x1 = dst.left + dst.width / 2 - s.left, y1 = dst.top + dst.height / 2 - s.top;
    let landed = 0;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'crew-fly';
      el.innerHTML = holdSvg(i + 2);
      el.style.left = x0 + 'px'; el.style.top = y0 + 'px';
      stage.appendChild(el);
      const mx = (x0 + x1) / 2 + (i - 1) * 90, my = Math.min(y0, y1) - 140 - i * 30;
      const anim = el.animate([
        { transform: 'translate(0,0) scale(.4) rotate(0deg)', opacity: 0 },
        { transform: `translate(${mx - x0}px, ${my - y0}px) scale(1.5) rotate(${180 + i * 60}deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${x1 - x0}px, ${y1 - y0}px) scale(.8) rotate(${360 + i * 90}deg)`, opacity: 1 },
      ], { duration: 1000 + i * 160, delay: i * 140, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
      anim.onfinish = () => {
        el.remove();
        landed++;
        // the counter climbs a share with each hold that lands, and each lands
        // a note higher than the last
        if (typeof finalTotal === 'number') {
          const start = Number(count.dataset.from || 0);
          count.textContent = String(Math.round(start + (finalTotal - start) * (landed / n)));
        } else count.textContent = String(Number(count.textContent) + 1);
        if (window.HoldsFx) HoldsFx.clink(landed - 1);
        wallet.classList.add('is-bump');
        setTimeout(() => wallet.classList.remove('is-bump'), 180);
        if (landed === n) {
          if (typeof finalTotal === 'number') count.textContent = String(finalTotal);
          if (window.HoldsFx && n >= 3) setTimeout(() => HoldsFx.fanfare(), 80);
          const plus = document.createElement('div');
          plus.className = 'crew-plus';
          plus.textContent = '+' + (typeof finalTotal === 'number' ? finalTotal - Number(count.dataset.from || 0) : n);
          plus.style.left = (x1 - 60) + 'px'; plus.style.top = (y1 + 26) + 'px';
          stage.appendChild(plus);
          setTimeout(() => plus.remove(), 1300);
        }
      };
    }
  }

  // ---------------------------------------------------------------- cheering
  function burst(fromEl) {
    if (calm()) return;
    const r = fromEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < 16; i++) {
      const el = document.createElement('div');
      el.className = 'crew-burst';
      el.innerHTML = holdSvg(i);
      el.style.left = cx + 'px'; el.style.top = cy + 'px';
      document.body.appendChild(el);
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const d = 80 + Math.random() * 90;
      el.animate([
        { transform: 'translate(0,0) scale(.3) rotate(0deg)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 40}px) scale(1.2) rotate(${Math.random() * 360}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${Math.cos(a) * d * 1.1}px, ${Math.sin(a) * d + 60}px) scale(.6) rotate(${Math.random() * 540}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).onfinish = () => el.remove();
    }
  }

  // ---------------------------------------------------------------- the card
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function openCard(html, focusSel) {
    cameFrom = document.activeElement;
    const card = $('crewCard');
    card.innerHTML = `<button class="crew-card-close" type="button" aria-label="${esc(t('crew.close'))}">${CLOSE}</button>` + html;
    card.querySelector('.crew-card-close').addEventListener('click', closeCard);
    const wrap = $('crewCardWrap');
    wrap.classList.add('is-open');
    wrap.setAttribute('aria-hidden', 'false');
    setTimeout(() => (card.querySelector(focusSel || '.crew-card-close') || card).focus(), 60);
    return card;
  }

  function closeCard() {
    const wrap = $('crewCardWrap');
    wrap.classList.remove('is-open');
    wrap.setAttribute('aria-hidden', 'true');
    if (cameFrom && cameFrom.focus) cameFrom.focus();
  }

  function openPerson(p) {
    const isMe = p.id === 'me';
    const groups = (p.groups || []).map(id => data.groups.find(g => g.id === id)).filter(Boolean);
    const mutual = data.friends.filter(f => f.id !== p.id).slice(0, Math.min(p.mutual || 0, 4));
    const ring = GRADS[(p.hue || 0) % GRADS.length][0];
    const card = openCard(`
      <div class="crew-card-head">
        ${avatarHtml(p, ` style-ring`)}
        <div>
          <h2 id="crewCardTitle" class="crew-card-name">${esc(isMe ? p.name : p.name)}</h2>
          <p class="crew-card-sub">@${esc(p.username)}${p.grade ? ' · ' + esc(t('crew.grade', { g: p.grade })) : ''}</p>
          ${p.live ? `<span class="crew-card-live">${esc(t('crew.liveFor', { n: p.liveMin }))}</span>` : ''}
        </div>
      </div>
      <div class="crew-stats">
        <div class="crew-stat"><strong>${holdSvg(3)}${p.holdsWeek}</strong><span>${esc(t('crew.statWeek'))}</span></div>
        <div class="crew-stat"><strong>${p.holdsTotal}</strong><span>${esc(t('crew.statTotal'))}</span></div>
        <div class="crew-stat"><strong>${p.streak}🔥</strong><span>${esc(t('crew.statStreak'))}</span></div>
      </div>
      ${!isMe && mutual.length ? `<div class="crew-mutual"><span class="crew-mutual-faces">${mutual.map(m => `<span class="crew-mini" style='--avatar-bg:${grad(m.hue)}'>${esc(initial(m))}</span>`).join('')}</span>${esc(t('crew.mutual', { n: p.mutual }))}</div>` : ''}
      ${groups.length ? `<div class="crew-chips">${groups.map(g => `<span class="crew-chip">${esc(g.name)}</span>`).join('')}</div>` : ''}
      <div class="crew-actions">
        ${isMe
          ? `<button class="crew-cheer" type="button" data-act="edit">${esc(t('crew.editProfile'))}</button>
             <button class="crew-chat" type="button" data-act="photo">${esc(t('crew.changePhoto'))}</button>`
          : `<button class="crew-cheer" type="button" data-act="cheer">${holdSvg(5, '#fff')}${esc(t('crew.cheer'))}</button>`}
      </div>
      ${!isMe && mode === 'live' ? `<div class="crew-more">
        <button class="crew-link" type="button" data-act="unfriend">${esc(t('crew.unfriend'))}</button>
        <button class="crew-link is-danger" type="button" data-act="block">${esc(t('crew.block'))}</button>
      </div>` : ''}
      <p class="crew-card-msg" role="status"></p>`);
    const av = card.querySelector('.crew-avatar');
    if (av) { av.removeAttribute('style-ring'); av.style.setProperty('--ring', ring); }
    const cheer = card.querySelector('[data-act="cheer"]');
    if (cheer) cheer.addEventListener('click', async () => {
      if (mode === 'live') {
        cheer.disabled = true;
        const r = await api('/crew/cheer', { method: 'POST', body: JSON.stringify({ username: p.username }) });
        if (!r.ok) {
          say(card, r.status === 409 ? t('crew.cheeredAlready', { name: p.name }) : detail(r));
          cheer.textContent = t(r.status === 409 ? 'crew.cheeredShort' : 'crew.cheer');
          cheer.disabled = r.status === 409;
          return;
        }
      }
      burst(cheer);
      cheer.textContent = t('crew.cheered', { name: p.name });
      cheer.disabled = true;
    });
    // Two presses for the lasting ones: the first asks, the second does.
    card.querySelectorAll('[data-act="unfriend"], [data-act="block"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.textContent = t(btn.dataset.act === 'block' ? 'crew.blockSure' : 'crew.unfriendSure', { name: p.name });
          return;
        }
        btn.disabled = true;
        const r = await api('/crew/' + btn.dataset.act, { method: 'POST', body: JSON.stringify({ username: p.username }) });
        if (!r.ok) { say(card, detail(r)); btn.disabled = false; return; }
        closeCard();
        load();
      });
    });
    const edit = card.querySelector('[data-act="edit"]');
    if (edit) edit.addEventListener('click', () => { closeCard(); if (window.AccountUI) AccountUI.open('accountRows'); });
    const photo = card.querySelector('[data-act="photo"]');
    if (photo) photo.addEventListener('click', () => { closeCard(); document.getElementById('profilePhotoInput')?.click(); });
  }

  function openGroup(g, people) {
    const total = people.reduce((s, p) => s + p.holdsWeek, 0);
    const card = openCard(`
      <h2 id="crewCardTitle" class="crew-card-name">${esc(g.name)}</h2>
      <p class="crew-card-sub">${esc(t('crew.groupSub', { n: people.length, h: total }))}</p>
      <div class="crew-results" style="margin-top:14px">
        ${people.sort((a, b) => b.holdsWeek - a.holdsWeek).map((p, i) => `
          <div class="crew-result">${avatarHtml(p)}
            <div class="crew-result-text"><strong>${i === 0 ? '👑 ' : ''}${esc(p.name)}</strong><span>${esc(t('crew.weekPill', { n: p.holdsWeek }))}</span></div>
            <button class="crew-add" type="button" data-id="${esc(p.id)}">${esc(t('crew.view'))}</button>
          </div>`).join('')}
      </div>`);
    card.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => {
      const p = people.find(x => x.id === b.dataset.id);
      if (p) openPerson(p);
    }));
  }

  function personRow(p, action) {
    const sub = p.mutual ? t('crew.mutual', { n: p.mutual }) : p.grade ? t('crew.grade', { g: p.grade }) : '';
    return `<div class="crew-result" role="listitem">${avatarHtml(p)}
      <div class="crew-result-text"><strong>${esc(p.name)}</strong><span>@${esc(p.username)}${sub ? ' · ' + esc(sub) : ''}</span></div>
      ${action}</div>`;
  }

  function openSearch() {
    const card = openCard(`
      <h2 id="crewCardTitle" class="crew-card-name">${esc(t('crew.findTitle'))}</h2>
      <p class="crew-card-sub">${esc(t('crew.findSub'))}</p>
      <div class="crew-search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
        <input class="crew-search-input" type="search" autocomplete="off" spellcheck="false" maxlength="21" placeholder="${esc(t('crew.findPlaceholder'))}" aria-label="${esc(t('crew.findPlaceholder'))}">
      </div>
      <div class="crew-results" role="list"></div>
      <p class="crew-card-msg" role="status"></p>`, '.crew-search-input');
    const input = card.querySelector('.crew-search-input');
    const list = card.querySelector('.crew-results');
    const sent = new Set(mode === 'live' ? [...data.outgoing] : []);
    const nowFriends = new Set();
    let results = null;           // what the server found for the text typed, or null
    let seq = 0;

    const addBtn = p => {
      if (nowFriends.has(p.username)) return `<button class="crew-add is-sent" type="button" disabled>${esc(t('crew.nowFriends'))}</button>`;
      if (p.request === 'incoming') return `<button class="crew-add" type="button" data-accept="${esc(p.username)}">${esc(t('crew.accept'))}</button>`;
      const isSent = sent.has(p.username) || p.request === 'sent';
      return `<button class="crew-add${isSent ? ' is-sent' : ''}" type="button" data-add="${esc(p.username)}"${isSent ? ' disabled' : ''}>${esc(t(isSent ? 'crew.sent' : 'crew.add'))}</button>`;
    };

    const draw = () => {
      const q = input.value.trim().toLowerCase().replace(/^@/, '');
      let html = '';
      if (mode === 'demo') {
        const people = data.suggested.filter(p => !q || p.name.toLowerCase().includes(q) || p.username.includes(q));
        html = people.map(p => personRow(p, addBtn(p))).join('');
      } else if (!q) {
        const waiting = data.incoming.filter(p => !nowFriends.has(p.username));
        if (waiting.length) {
          html += `<p class="crew-results-title">${esc(t('crew.wantsYou'))}</p>` + waiting.map(p => personRow(p,
            `<span class="crew-pair"><button class="crew-add" type="button" data-accept="${esc(p.username)}">${esc(t('crew.accept'))}</button>
             <button class="crew-x" type="button" data-decline="${esc(p.username)}" aria-label="${esc(t('crew.decline'))}">${CLOSE}</button></span>`)).join('');
        }
        if (data.suggested.length) {
          html += `<p class="crew-results-title">${esc(t('crew.mayKnow'))}</p>` + data.suggested.map(p => personRow(p, addBtn(p))).join('');
        }
        if (!html) html = `<p class="crew-card-sub">${esc(t('crew.findHint'))}</p>`;
      } else if (q.length < 3) {
        html = `<p class="crew-card-sub">${esc(t('crew.findMore'))}</p>`;
      } else if (results === null) {
        html = `<p class="crew-card-sub">${esc(t('crew.searching'))}</p>`;
      } else {
        html = results.map(p => personRow(p, addBtn(p))).join('');
      }
      list.innerHTML = html || `<p class="crew-card-sub">${esc(t('crew.noOne'))}</p>`;
      list.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => add(b)));
      list.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => accept(b)));
      list.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click', () => decline(b)));
    };

    async function add(b) {
      const name = b.dataset.add;
      if (sent.has(name)) return;
      if (mode === 'demo') { sent.add(name); burst(b); draw(); return; }
      b.disabled = true;
      const r = await api('/crew/requests', { method: 'POST', body: JSON.stringify({ username: name }) });
      if (!r.ok) { say(card, detail(r)); b.disabled = false; return; }
      burst(b);
      if (r.data.status === 'friends') { nowFriends.add(name); load(); } else sent.add(name);
      draw();
    }
    async function accept(b) {
      const name = b.dataset.accept;
      b.disabled = true;
      const r = await api('/crew/requests/accept', { method: 'POST', body: JSON.stringify({ username: name }) });
      if (!r.ok) { say(card, detail(r)); b.disabled = false; return; }
      burst(b);
      nowFriends.add(name);
      draw();
      load();
    }
    async function decline(b) {
      const name = b.dataset.decline;
      b.disabled = true;
      await api('/crew/requests/decline', { method: 'POST', body: JSON.stringify({ username: name }) });
      data.incoming = data.incoming.filter(p => p.username !== name);
      draw();
      load();
    }

    let timer = 0;
    input.addEventListener('input', () => {
      results = null;
      draw();
      if (mode !== 'live') return;
      clearTimeout(timer);
      const q = input.value.trim().toLowerCase().replace(/^@/, '');
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        const mine = ++seq;
        const r = await api('/crew/search?q=' + encodeURIComponent(q));
        if (mine !== seq) return;            // a newer search is on its way
        results = r.ok && Array.isArray(r.data) ? r.data.map(person) : [];
        draw();
      }, 260);
    });
    draw();
  }

  function say(card, text) {
    const el = card.querySelector('.crew-card-msg');
    if (el) el.textContent = text || '';
  }

  function openWallet() {
    const card = openCard(`
      <h2 id="crewCardTitle" class="crew-card-name">${esc(t('crew.walletTitle', { n: $('crewWalletCount').textContent }))}</h2>
      <p class="crew-card-sub">${esc(t('crew.walletSub'))}</p>
      <div class="crew-results" style="margin-top:14px">
        ${[['crew.earnSolved', 25, 0], ['crew.earnOnTime', 20, 1], ['crew.earnFocus', 5, 2], ['crew.earnStreak', 15, 4], ['crew.earnBreak', 10, 5]].map(([k, n, i]) => `
          <div class="crew-result">${holdSvg(i)}<div class="crew-result-text"><strong>${esc(t(k))}</strong></div><b class="crew-stat-n">+${n}</b></div>`).join('')}
      </div>`);
    card.querySelectorAll('.crew-result > .crew-hold').forEach(h => { h.style.width = '34px'; h.style.height = '34px'; h.style.flex = 'none'; });
  }

  // ---------------------------------------------------------------- showing
  function demoShown() {
    mode = 'demo';
    render(demo(), earnedShown ? undefined : demo().me.holdsTotal - 3);
    if (!earnedShown && !calm()) {
      earnedShown = true;
      setTimeout(() => earn(3), 1500);
    } else {
      earnedShown = true;
      $('crewWalletCount').textContent = String(data.me.holdsTotal);
    }
  }

  // The real mountain. Called on showing the screen and after anything that
  // changes it (a new friend, a block); the holds earned since this device last
  // looked fly into the counter.
  async function load() {
    if (!window.Auth || !Auth.isLoggedIn()) { demoShown(); return; }
    const mine = ++loadSeq;
    if (!built) build();
    const r = await api('/crew');
    if (mine !== loadSeq || $('view-crew').classList.contains('hidden')) return;
    if (!r.ok) {
      if (!data || mode !== 'live') gate('error', r);
      return;
    }
    if (r.data.needs) { gate(r.data.needs, r); return; }
    mode = 'live';
    closeGate();
    const d = fromApi(r.data);
    const before = seen();
    const total = d.me.holdsTotal;
    const gained = before === null ? 0 : total - before;
    render(d, gained > 0 && !calm() ? before : total);
    remember(total);
    if (window.HoldsFx) HoldsFx.markSeen(total);
    if (gained > 0 && !calm()) {
      $('crewWalletCount').dataset.from = String(before);
      setTimeout(() => earn(Math.min(gained, 6), null, total), 900);
    }
  }

  // ---------------------------------------------------------------- the gates
  // Before the mountain: set up (username, month and year of birth), wait for
  // a parent, or this is not a student account. The mountain stays behind the
  // card, empty, so the screen already looks like what it will become.
  function emptyMountain() {
    const u = (window.Auth && Auth.getUser()) || {};
    const photo = window.ProfilePhoto ? safePhoto(ProfilePhoto.get()) : null;
    mode = 'gate';
    render({ me: { id: 'me', name: u.display_name || t('crew.you'), username: u.username || '', grade: u.grade,
                   holdsWeek: 0, holdsTotal: 0, streak: 0, photo, hue: hueOf(u.username || u.id) },
             friends: [], incoming: [], suggested: [], groups: [], outgoing: new Set() });
  }

  function closeGate() {
    const g = $('crewGate');
    if (g) g.remove();
  }

  function gate(kind, r) {
    emptyMountain();
    closeGate();
    const box = document.createElement('div');
    box.id = 'crewGate';
    box.className = 'crew-gate';
    const card = document.createElement('div');
    card.className = 'crew-card crew-gate-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'crewGateTitle');
    box.appendChild(card);
    $('crewStage').appendChild(box);

    if (kind === 'setup') {
      const u = (window.Auth && Auth.getUser()) || {};
      const year = new Date().getFullYear();
      const years = [];
      for (let y = year - 6; y >= year - 20; y--) years.push(y);
      const months = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString(window.I18n && I18n.get() === 'bg' ? 'bg-BG' : 'en-GB', { month: 'long' }));
      const suggestion = (r.data.username || u.username || (u.display_name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')).slice(0, 20);
      card.innerHTML = `
        <h2 id="crewGateTitle" class="crew-card-name">${esc(t('crew.setupTitle'))}</h2>
        <p class="crew-card-sub">${esc(t('crew.setupSub'))}</p>
        <form class="crew-setup" novalidate>
          <label class="crew-field"><span>${esc(t('crew.setupUsername'))}</span>
            <span class="crew-at"><b>@</b><input name="username" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(suggestion)}"${r.data.username ? ' readonly' : ''} required></span>
            <small>${esc(t(r.data.username ? 'crew.setupUsernameKept' : 'crew.setupUsernameHint'))}</small></label>
          <div class="crew-field"><span>${esc(t('crew.setupBirth'))}</span>
            <span class="crew-row">
              <select name="month" aria-label="${esc(t('crew.setupMonth'))}"><option value="">${esc(t('crew.setupMonth'))}</option>${months.map((m, i) => `<option value="${i + 1}">${esc(m)}</option>`).join('')}</select>
              <select name="year" aria-label="${esc(t('crew.setupYear'))}"><option value="">${esc(t('crew.setupYear'))}</option>${years.map(y => `<option value="${y}">${y}</option>`).join('')}</select>
            </span>
            <small>${esc(t('crew.setupBirthHint'))}</small></div>
          <button class="crew-cheer crew-go" type="submit">${esc(t('crew.setupGo'))}</button>
          <p class="crew-card-msg" role="alert"></p>
        </form>`;
      const form = card.querySelector('form');
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const username = form.username.value.trim().replace(/^@/, '').toLowerCase();
        const month = Number(form.month.value), yearV = Number(form.year.value);
        // an account that has a username keeps it (it may be how they sign in)
        if (!r.data.username && (!/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(username) || username.includes('..'))) { say(card, t('crew.setupBadName')); return; }
        if (!month || !yearV) { say(card, t('crew.setupNeedBirth')); return; }
        const go = form.querySelector('.crew-go');
        go.disabled = true;
        const res = await api('/crew/profile', { method: 'POST', body: JSON.stringify({ username, birth_month: month, birth_year: yearV }) });
        go.disabled = false;
        if (!res.ok) { say(card, detail(res)); return; }
        if (window.Auth && Auth.updateUser) Auth.updateUser({ ...(Auth.getUser() || {}), username });
        burst(go);
        uploadPhoto();
        closeGate();
        load();
      });
      setTimeout(() => (r.data.username ? form.month : form.username).focus(), 80);
    } else if (kind === 'parent') {
      card.innerHTML = `
        <h2 id="crewGateTitle" class="crew-card-name">${esc(t('crew.parentTitle'))}</h2>
        <p class="crew-card-sub">${esc(t(r.data.has_parent ? 'crew.parentAsk' : 'crew.parentLink'))}</p>
        <div class="crew-actions">
          ${r.data.has_parent ? '' : `<button class="crew-cheer" type="button" data-act="family">${esc(t('crew.parentLinkBtn'))}</button>`}
          <button class="crew-chat" type="button" data-act="again">${esc(t('crew.checkAgain'))}</button>
        </div>`;
      card.querySelector('[data-act="family"]')?.addEventListener('click', () => window.AccountUI && AccountUI.open('setFamily'));
      card.querySelector('[data-act="again"]').addEventListener('click', () => load());
    } else if (kind === 'role') {
      card.innerHTML = `
        <h2 id="crewGateTitle" class="crew-card-name">${esc(t('crew.roleTitle'))}</h2>
        <p class="crew-card-sub">${esc(t('crew.roleSub'))}</p>`;
    } else {
      card.innerHTML = `
        <h2 id="crewGateTitle" class="crew-card-name">${esc(t('crew.errorTitle'))}</h2>
        <p class="crew-card-sub">${esc(detail(r))}</p>
        <div class="crew-actions"><button class="crew-cheer" type="button" data-act="again">${esc(t('crew.checkAgain'))}</button></div>`;
      card.querySelector('[data-act="again"]').addEventListener('click', () => load());
    }
  }

  // ---------------------------------------------------------------- the rest of the app
  // The photo from Settings is the one friends see.
  async function uploadPhoto() {
    if (!window.Auth || !Auth.isLoggedIn() || !window.ProfilePhoto) return;
    const photo = safePhoto(ProfilePhoto.get());
    if (photo) await api('/crew/avatar', { method: 'POST', body: JSON.stringify({ data: photo }) });
    else await api('/crew/avatar', { method: 'DELETE' });
  }

  // A focus session running: friends see it glow. A heartbeat every minute;
  // the server forgets it three minutes after the last one.
  let liveTimer = 0;
  function focusLive() {
    const running = !!(window.Focus && Focus.isRunning && Focus.isRunning());
    if (!window.Auth || !Auth.isLoggedIn()) return;
    if (running && !liveTimer) {
      api('/crew/live', { method: 'POST', body: JSON.stringify({ on: true }) });
      liveTimer = setInterval(() => {
        if (window.Focus && Focus.isRunning()) api('/crew/live', { method: 'POST', body: JSON.stringify({ on: true }) });
        else focusLive();
      }, 60000);
    } else if (!running && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = 0;
      api('/crew/live', { method: 'POST', body: JSON.stringify({ on: false }) });
    }
  }

  function visible() { return built && !$('view-crew').classList.contains('hidden'); }

  function shown() {
    if (window.Auth && Auth.isLoggedIn()) load();
    else { closeGate(); demoShown(); }
  }

  function init() {
    if (!$('crewStage')) return;
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'crew') shown();
      else { stopHeadlines(); if ($('crewCardWrap')) closeCard(); }
    });
    window.addEventListener('climby:lang-changed', () => { if (visible()) shown(); });
    window.addEventListener('climby:auth-changed', () => { if (visible()) shown(); });
    window.addEventListener('climby:photo-changed', () => {
      uploadPhoto().then(() => { if (visible()) shown(); });
    });
    window.addEventListener('climby:focus-live', focusLive);
    window.addEventListener('climby:break-taken', () => {
      if (window.Auth && Auth.isLoggedIn()) {
        api('/crew/break', { method: 'POST' }).then(() => window.dispatchEvent(new CustomEvent('climby:holds-maybe')));
      }
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (visible() && data) render(data); }, 250);
    });
    if (!$('view-crew').classList.contains('hidden')) shown();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { render, earn, load };
})();

window.Crew = Crew;
