// homework-reminders.js — a nudge in the evening, before the homework is forgotten.
//
// Two at most a day, and only when there is something to do: homework due
// today or tomorrow, or already late. The first comes after half past six and
// is gentle; the second, after half past eight, says it is getting late. None
// while a focus session runs — that student is already at it — and none at
// all once the switch in Settings is off.
//
// A Windows notification through the desktop app (the same door the break
// reminders use), and a toast when Climby is the window in front.
const HomeworkReminders = (() => {
  const PREF = 'climby-hw-remind';            // 'off' turns them off on this device
  const SENT = 'climby-hw-reminded:';         // + account id: { day, sent: ['early'|'late'] }
  const SLOTS = [
    { id: 'early', from: 18 * 60 + 30, kind: 'early', lines: 6 },
    { id: 'late', from: 20 * 60 + 30, kind: 'late', lines: 5 },
  ];
  const UNTIL = 22 * 60 + 30;                 // after this, let them sleep
  const CHECK_MS = 5 * 60 * 1000;
  let timer = null;

  const t = (k, v) => (window.t ? window.t(k, v) : k);

  function enabled() {
    try { return localStorage.getItem(PREF) !== 'off'; } catch { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* this visit only */ }
    paint();
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function sentToday(uid) {
    try {
      const s = JSON.parse(localStorage.getItem(SENT + uid) || 'null');
      return s && s.day === today() && Array.isArray(s.sent) ? s.sent : [];
    } catch { return []; }
  }

  function markSent(uid, id) {
    const sent = sentToday(uid).concat(id);
    try { localStorage.setItem(SENT + uid, JSON.stringify({ day: today(), sent })); } catch { /* may repeat once */ }
  }

  // The slot due now, if any: the latest one whose time has come and that has
  // not been sent. Opening the app at nine sends the late one, not both.
  function dueSlot(uid, minutes) {
    if (minutes >= UNTIL) return null;
    const sent = sentToday(uid);
    const open = SLOTS.filter(s => minutes >= s.from);
    const slot = open[open.length - 1];
    if (!slot || sent.includes(slot.id)) return null;
    return slot;
  }

  function pick(kind, count) {
    return Math.floor(Math.random() * count);
  }

  function notify(title, body) {
    const bridge = window.CLIMBY_DESKTOP;
    if (bridge && typeof bridge.notify === 'function') {
      bridge.notify({ title, body, tag: 'climby-homework' }).catch(() => {});
    } else {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body, tag: 'climby-homework', icon: 'icon-192.png' });
        }
      } catch { /* the toast is still there */ }
    }
    if (window.Toast && document.visibilityState === 'visible') Toast.show(body);
  }

  async function check() {
    if (!enabled() || !window.Auth || !Auth.isLoggedIn() || !window.Checklist) return;
    if (document.body.classList.contains('focus-live')) return;
    const user = Auth.getUser();
    if (!user || !user.id || (user.role && user.role !== 'student')) return;
    const now = new Date();
    const slot = dueSlot(String(user.id), now.getHours() * 60 + now.getMinutes());
    if (!slot) return;
    let pending;
    try { pending = await Checklist.getPendingTasks(); } catch { return; }
    const soon = pending.filter(task => {
      const d = Checklist.daysUntil(task.deadline);
      return d !== null && d <= 1;
    });
    if (!soon.length) return;
    // the one due first names the reminder
    soon.sort((a, b) => Checklist.daysUntil(a.deadline) - Checklist.daysUntil(b.deadline));
    const first = soon[0];
    const task = first.subject ? `${first.subject}: ${first.text}` : first.text;
    const i = pick(slot.kind, slot.lines);
    const body = t(`hw.${slot.kind}.${i}`, { task: task.length > 60 ? task.slice(0, 58) + '…' : task, n: soon.length });
    markSent(String(user.id), slot.id);
    notify(t(slot.kind === 'late' ? 'hw.titleLate' : 'hw.title'), body);
  }

  function paint() {
    const sw = document.getElementById('hwRemindOn');
    if (sw) sw.checked = enabled();
  }

  function start() {
    if (timer) return;
    setTimeout(check, 60 * 1000);
    timer = setInterval(check, CHECK_MS);
  }

  function init() {
    const sw = document.getElementById('hwRemindOn');
    if (sw) sw.addEventListener('change', () => setEnabled(sw.checked));
    paint();
    start();
    // back from sleep or another window: look now rather than in five minutes
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  document.addEventListener('DOMContentLoaded', init);
  return { check, dueSlot, enabled, setEnabled };
})();

window.HomeworkReminders = HomeworkReminders;
