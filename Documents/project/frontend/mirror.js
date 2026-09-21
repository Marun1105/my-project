// mirror.js — the first screen knows what you did.
//
// ClimbAI's home looked the same on day 1 and day 100: four cards and a lot of
// nothing. This is one line above the cards that changes every day — what you
// did yesterday (or today so far), what is due today, and how many days in a
// row you have shown up. People finish what already looks started; that is the
// whole trick, and it costs one request.
//
// It says nothing to a brand-new account. The cards are the invitation; a
// second empty state on top of them would only be noise. And it never counts
// what you *didn't* do — no "overdue", no "you missed yesterday". Effort only.
const Mirror = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  // A calendar day, in the person's own time zone. ISO strings from the server
  // are UTC; "yesterday" has to mean the day the child remembers, not the one
  // in London.
  function dayKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayOf(iso) { return dayKey(new Date(iso)); }
  function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d); }
  // Task deadlines arrive as plain YYYY-MM-DD, with no time zone at all.
  function localDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function get(path) {
    const res = await Net.fetch(BACKEND + path, {
      headers: { Authorization: `Bearer ${Auth.getToken()}` },
    });
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json();
  }

  // Consecutive days with any activity, ending today or yesterday. One missed
  // day is forgiven per streak: a streak that dies on the first missed day is a
  // streak that makes people quit on the second, because the thing they were
  // protecting is already gone.
  function streakOf(activeDays) {
    let n = 0;
    let back = activeDays.has(daysAgo(0)) ? 0 : 1;
    let grace = 1;
    for (;;) {
      if (activeDays.has(daysAgo(back))) { n++; back++; continue; }
      if (grace && n > 0) { grace = 0; back++; continue; }
      break;
    }
    return n;
  }

  function plural(n, one, many) { return n === 1 ? t(one) : t(many, { n }); }

  function summarise(day, events) {
    const on = events.filter(e => dayOf(e.at) === day);
    const q = on.filter(e => e.kind === 'question').length;
    const secs = on.filter(e => e.kind === 'session').reduce((a, e) => a + (e.seconds || 0), 0);
    const done = on.filter(e => e.kind === 'task').length;
    const parts = [];
    if (q) parts.push(plural(q, 'mirror.qOne', 'mirror.qMany'));
    if (secs >= 60) parts.push(t('mirror.min', { n: Math.round(secs / 60) }));
    if (done) parts.push(plural(done, 'mirror.doneOne', 'mirror.doneMany'));
    return parts;
  }

  let seq = 0;

  // The last few questions, under the cards. Only when the cards are showing —
  // once the camera or a paper is open, the screen is that, not this.
  const RECENT_MAX = 3;
  let recentSeq = 0;

  async function renderRecent() {
    const box = $('recentAsked');
    const list = $('recentAskedList');
    if (!box || !list) return;
    if (!window.Auth || !Auth.isLoggedIn()) { box.classList.add('hidden'); return; }
    const my = ++recentSeq;
    let scans;
    try { scans = await get('/scans'); } catch { return; }
    if (my !== recentSeq) return;
    scans = (scans || []).slice(0, RECENT_MAX);
    list.textContent = '';
    for (const scan of scans) {
      const li = document.createElement('li');
      const q = document.createElement('span');
      q.className = 'recent-asked-q';
      q.textContent = scan.question.length > 110 ? scan.question.slice(0, 107) + '…' : scan.question;
      const when = document.createElement('span');
      when.className = 'recent-asked-when';
      when.textContent = window.History && History.relativeAgo ? History.relativeAgo(scan.created_at) : '';
      li.append(q, when);
      list.appendChild(li);
    }
    box.classList.toggle('hidden', scans.length === 0);
  }

  async function render() {
    renderRecent();
    const el = $('mirror');
    if (!el) return;
    // Events arrive from every screen — a task ticked on the Route, a chat
    // message. Fetching for a line that is inside a hidden view is a wasted
    // request; the view-shown handler redraws it the moment it matters.
    if (window.Nav && Nav.currentView && Nav.currentView() !== 'tutor') return;
    if (!window.Auth || !Auth.isLoggedIn()) { el.classList.add('hidden'); return; }
    const my = ++seq;
    let data;
    try {
      // /activity is every moment of effort in the last 120 days, uncapped —
      // the list endpoints stop at the last 30 or 50 items, which would cap a
      // daily user's streak at about two weeks. "today" goes along because the
      // server can't know which calendar day it is where the child sits.
      data = await get('/activity?today=' + localDate(new Date()));
    } catch {
      return; // the cards below still work; this line is a nicety, not a screen
    }
    if (my !== seq) return;

    const events = data.events || [];
    const today = summarise(daysAgo(0), events);
    const yesterday = summarise(daysAgo(1), events);
    const dueToday = data.due_today || 0;

    const active = new Set(events.map(e => dayOf(e.at)));
    const streak = streakOf(active);

    const sentences = [];
    if (today.length) sentences.push(t('mirror.today', { parts: today.join(', ') }));
    else if (yesterday.length) sentences.push(t('mirror.yesterday', { parts: yesterday.join(', ') }));
    if (dueToday) sentences.push(plural(dueToday, 'mirror.dueOne', 'mirror.dueMany'));

    if (!sentences.length && streak < 2) { el.classList.add('hidden'); return; }

    el.textContent = '';
    el.append(sentences.join(' '));
    if (streak >= 2) {
      const flame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      flame.setAttribute('class', 'streak-flame');
      flame.setAttribute('viewBox', '0 0 24 24');
      flame.setAttribute('fill', 'currentColor');
      flame.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M13.5 2.5c.4 2.6-.7 4.2-2 5.6-1.4 1.5-2.9 2.9-2.9 5.4a5.4 5.4 0 0 0 10.8 0c0-1.6-.6-2.9-1.5-4.2-.3 1-.9 1.6-1.7 1.9.6-2.9-.6-6.6-2.7-8.7z');
      flame.append(path);
      const span = document.createElement('span');
      span.className = 'mirror-streak';
      span.append(flame, t('mirror.streak', { n: streak }));
      el.append(sentences.length ? ' ' : '', span);
    }
    el.classList.remove('hidden');
  }

  function init() {
    const all = document.querySelector('.recent-asked-all');
    if (all) all.addEventListener('click', () => { if (window.Nav) Nav.activate('history'); });
    window.addEventListener('climby:view-shown', e => { if (e.detail.view === 'tutor') render(); });
    window.addEventListener('climby:auth-changed', render);
    window.addEventListener('climby:lang-changed', render);
    // Something just happened on another screen — a task ticked, a session
    // saved, a question asked. The line should already be true when you return.
    window.addEventListener('climby:activity', render);
    window.addEventListener('climby:tasks-changed', render);
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { render, streakOf };
})();

window.Mirror = Mirror;
