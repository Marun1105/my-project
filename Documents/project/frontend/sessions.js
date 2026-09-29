// sessions.js — what the focus sessions actually were, not just that they happened.
//
// Ascent kept every session on the server and showed the student one number: a
// streak of days. The screen below the timer was empty, and so was the record —
// "3 days in a row" says nothing about whether those days were twelve minutes
// or two hours, or whether the camera saw someone working or an empty chair.
//
// So: the last sessions, newest first, each openable for its detail. Only what
// is really stored — when it started, how long it ran, and how much of the
// watched time was spent facing the work. Nothing is inferred and nothing is
// invented, because a number a student cannot trust is worse than no number.
const Sessions = (() => {
  const BACKEND = window.CLIMBY_BACKEND;
  const SHOWN = 10;          // the server keeps 30; a wall of them helps nobody

  function t(key, vars) { return window.t ? window.t(key, vars) : key; }

  function minutes(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) return t('sessions.min', { n: m });
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? t('sessions.hourMin', { h, m: rest }) : t('sessions.hour', { h });
  }

  // "Today, 16:40" / "Monday, 16:40" / "12 Mar, 16:40" — near days by name,
  // because "3 days ago at 16:40" is arithmetic the reader has to do.
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const lang = window.I18n && I18n.get() === 'bg' ? 'bg-BG' : 'en-GB';
    const clock = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const days = Math.floor((midnight - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return t('sessions.today', { time: clock });
    if (days === 1) return t('sessions.yesterday', { time: clock });
    if (days < 7) return d.toLocaleDateString(lang, { weekday: 'long' }) + ', ' + clock;
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'short' }) + ', ' + clock;
  }

  function ended(iso, seconds) {
    const d = new Date(new Date(iso).getTime() + seconds * 1000);
    if (isNaN(d)) return '';
    const lang = window.I18n && I18n.get() === 'bg' ? 'bg-BG' : 'en-GB';
    return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  }

  function row(session) {
    const item = document.createElement('div');
    item.className = 'session-row';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'session-head';
    head.setAttribute('aria-expanded', 'false');

    const when_ = document.createElement('span');
    when_.className = 'session-when';
    when_.textContent = when(session.created_at);

    const length = document.createElement('span');
    length.className = 'session-length';
    length.textContent = minutes(session.duration_seconds);

    const chevron = document.createElement('span');
    chevron.className = 'session-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

    head.append(when_, length, chevron);

    const body = document.createElement('div');
    body.className = 'session-detail hidden';

    const lines = [
      [t('sessions.started'), when(session.created_at)],
      [t('sessions.ended'), ended(session.created_at, session.duration_seconds)],
      [t('sessions.lasted'), minutes(session.duration_seconds)],
    ];
    for (const [label, value] of lines) {
      const line = document.createElement('div');
      line.className = 'session-line';
      const k = document.createElement('span'); k.textContent = label;
      const v = document.createElement('strong'); v.textContent = value;
      line.append(k, v);
      body.appendChild(line);
    }

    // focus_pct is null when the camera was off for the whole session. Saying
    // so is better than printing 0%, which reads as "you did not work".
    const line = document.createElement('div');
    line.className = 'session-line';
    const k = document.createElement('span'); k.textContent = t('sessions.focus');
    const v = document.createElement('strong');
    if (session.focus_pct === null || session.focus_pct === undefined) {
      v.textContent = t('sessions.noCamera');
      v.className = 'session-dim';
    } else {
      v.textContent = session.focus_pct + '%';
    }
    line.append(k, v);
    body.appendChild(line);

    if (session.focus_pct !== null && session.focus_pct !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'session-bar';
      const fill = document.createElement('span');
      fill.style.width = Math.max(0, Math.min(100, session.focus_pct)) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
      const note = document.createElement('p');
      note.className = 'session-note';
      note.textContent = t('sessions.focusNote');
      body.appendChild(note);
    }

    head.addEventListener('click', () => {
      const open = body.classList.contains('hidden');
      body.classList.toggle('hidden', !open);
      item.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    item.append(head, body);
    return item;
  }

  async function render() {
    const host = document.getElementById('sessionHistory');
    if (!host) return;
    if (!window.Auth || !Auth.isLoggedIn()) { host.classList.add('hidden'); return; }

    let list = [];
    try {
      const res = await Net.fetch(BACKEND + '/focus', {
        headers: { Authorization: 'Bearer ' + Auth.getToken() },
      });
      if (!res.ok) throw new Error('no');
      list = await res.json();
    } catch {
      host.classList.add('hidden');    // a missing history is not worth an error
      return;
    }

    host.innerHTML = '';
    if (!Array.isArray(list) || !list.length) { host.classList.add('hidden'); return; }

    const title = document.createElement('h2');
    title.className = 'session-history-title';
    title.textContent = t('sessions.title');
    host.appendChild(title);

    for (const session of list.slice(0, SHOWN)) host.appendChild(row(session));
    host.classList.remove('hidden');
  }

  function init() {
    window.addEventListener('climby:view-shown', e => { if (e.detail.view === 'focus') render(); });
    window.addEventListener('climby:auth-changed', render);
    // a session that just ended belongs at the top of its own history
    window.addEventListener('climby:activity', render);
    render();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { render };
})();

window.Sessions = Sessions;
