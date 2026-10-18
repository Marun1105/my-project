// breaks.js — Climby suggests a break during a Focus session.
//
// The owner asked for it: during a long session Climby tells you, in its own
// voice, to stop for a few minutes — differently by the time of day, every
// 30–45 minutes, never the same line twice. The rules live in
// break-schedule.js; this is the showing: a card in the app, a Windows
// notification on the desktop, and the countdown while the break runs.
//
// Time is study time, not the wall clock: a session paused for the face check
// or for a break does not move the next reminder closer.
const Breaks = (() => {
  const B = window.BreakSchedule;
  const CHECK_EVERY_MS = 15 * 1000;

  let dueAtMs = null;     // the next reminder, in study milliseconds
  let watcher = null;     // the 15-second check while a session runs
  let card = null;        // the card on screen, if any
  let countdown = null;   // the 1-second tick of a running break
  let breakEndsAt = 0;
  let lastLine = {};      // per time of day, so a line never repeats back to back

  function t(key, vars) { return window.t ? window.t(key, vars) : key; }
  function focus() { return window.Focus; }

  // ---------- telling the student ----------

  function line(kind) {
    const count = kind === 'over' ? B.OVER_LINES : B.LINES_PER_BUCKET;
    const i = B.pickLine(count, lastLine[kind]);
    lastLine[kind] = i;
    return t(`breaks.${kind}.${i}`);
  }

  // A Windows notification through the desktop app, which allows exactly this
  // and nothing else (see main.js). In a browser, only if the person has
  // already allowed notifications for the page: Climby never asks out of nowhere.
  function notify(title, body, tag) {
    const bridge = window.CLIMBY_DESKTOP;
    if (bridge && typeof bridge.notify === 'function') {
      bridge.notify({ title, body, tag }).catch(() => {});
      return;
    }
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, tag, icon: 'icon-192.png' });
      }
    } catch { /* the card is still there */ }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function closeCard() {
    if (card) card.remove();
    card = null;
  }

  function showCard(build) {
    closeCard();
    card = el('section', 'break-card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-label', t('breaks.aria'));
    build(card);
    document.body.appendChild(card);
    requestAnimationFrame(() => card && card.classList.add('is-in'));
  }

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- the reminder ----------

  function remind() {
    const f = focus();
    if (!f || !f.isRunning() || f.onBreak()) return;
    const kind = B.bucket(new Date().getHours());
    const text = line(kind);
    const minutes = B.breakMs(f.activeMs()) / B.MINUTE;
    // Whatever the student does with it, the next one is a whole interval away.
    dueAtMs = f.activeMs() + B.intervalMs(new Date());
    showCard(c => {
      c.append(el('p', 'break-card-title', t('breaks.title')), el('p', 'break-card-line', text));
      const row = el('div', 'break-card-actions');
      row.append(
        button(t('breaks.snooze'), 'break-btn break-btn-quiet', snooze),
        button(t('breaks.take', { n: minutes }), 'break-btn', takeBreak),
      );
      c.appendChild(row);
    });
    notify(t('breaks.title'), text, 'climby-break');
  }

  function snooze() {
    const f = focus();
    if (f && f.isRunning()) dueAtMs = f.activeMs() + B.SNOOZE_MS;
    closeCard();
  }

  function takeBreak() {
    const f = focus();
    if (!f || !f.isRunning()) { closeCard(); return; }
    const length = B.breakMs(f.activeMs());
    if (!f.startBreak()) return;
    // Taking the suggested break earns a hold (crew.js tells the server).
    window.dispatchEvent(new CustomEvent('climby:break-taken'));
    breakEndsAt = Date.now() + length;
    showCard(c => {
      c.classList.add('is-break');
      c.append(el('p', 'break-card-title', t('breaks.onBreak')), el('p', 'break-card-line break-card-time'));
      const row = el('div', 'break-card-actions');
      row.append(button(t('breaks.end'), 'break-btn', () => finishBreak(false)));
      c.appendChild(row);
    });
    paintCountdown();
    clearInterval(countdown);
    countdown = setInterval(paintCountdown, 1000);
  }

  function paintCountdown() {
    const left = Math.max(0, breakEndsAt - Date.now());
    if (left <= 0) { finishBreak(true); return; }
    const total = Math.ceil(left / 1000);
    const time = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    const slot = card && card.querySelector('.break-card-time');
    if (slot) slot.textContent = t('breaks.left', { time });
  }

  // timeUp: the countdown ran out (say so, out loud), rather than "I'm back"
  function finishBreak(timeUp) {
    clearInterval(countdown);
    countdown = null;
    const f = focus();
    if (f) f.endBreak();
    if (f && f.isRunning()) dueAtMs = f.activeMs() + B.intervalMs(new Date());
    if (!timeUp) { closeCard(); return; }
    const text = line('over');
    showCard(c => {
      c.append(el('p', 'break-card-title', t('breaks.overTitle')), el('p', 'break-card-line', text));
      const row = el('div', 'break-card-actions');
      row.append(button(t('breaks.end'), 'break-btn', closeCard));
      c.appendChild(row);
    });
    notify(t('breaks.overTitle'), text, 'climby-break-over');
  }

  // ---------- following the session ----------

  function check() {
    const f = focus();
    const live = document.body.classList.contains('focus-live');
    if (!f || !f.isRunning()) {
      if (!live) stop();   // ended; while it is still starting (face check), wait
      return;
    }
    if (f.onBreak() || card) return;
    if (dueAtMs === null) dueAtMs = f.activeMs() + B.intervalMs(new Date());
    if (f.activeMs() >= dueAtMs) remind();
  }

  function start() {
    if (watcher) return;
    dueAtMs = null;
    watcher = setInterval(check, CHECK_EVERY_MS);
    check();
  }

  function stop() {
    clearInterval(watcher);
    watcher = null;
    clearInterval(countdown);
    countdown = null;
    dueAtMs = null;
    closeCard();
  }

  function init() {
    if (!B) return;
    // focus.js announces every start and end of a session with this event
    window.addEventListener('climby:focus-live', () => {
      if (document.body.classList.contains('focus-live')) start(); else stop();
    });
    const bridge = window.CLIMBY_DESKTOP;
    if (bridge && typeof bridge.onNotificationClick === 'function') {
      // the window is already in front (main.js); bring the student to the session
      bridge.onNotificationClick(() => { if (window.Nav && card) Nav.activate('focus'); });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  // for the browser check (pagecheck.js) and anyone curious
  return { remind, takeBreak, finishBreak, snooze, check };
})();

window.Breaks = Breaks;
