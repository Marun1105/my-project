// profile.js — who is this? Three questions, once, after the first sign-in.
//
// Grade, town, how they heard of Climby. The grade is the one that matters:
// the tutor reads it and speaks to a first-grader and a tenth-grader
// differently — not a dumber and a smarter answer, a different register.
// The other two are for knowing who uses this and where it spreads.
//
// It is skippable. "Later" puts it away for a week; Settings → About you
// brings it back any time, prefilled.
const Profile = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const LATER_KEY = 'climby-profile-later';
  const LATER_MS = 7 * 24 * 3600 * 1000;
  let picked = { grade: null, heard_from: null };

  function user() { return (window.Auth && Auth.getUser()) || null; }
  function isStudent() { const u = user(); return !u || !u.role || u.role === 'student'; }

  function needsAsking(u) {
    if (!u) return false;
    if (isStudent() && u.grade == null) return true;
    return u.heard_from == null;
  }

  function snoozed() {
    try { const t = Number(localStorage.getItem(LATER_KEY) || 0); return t && Date.now() - t < LATER_MS; }
    catch { return false; }
  }

  function buildGrades() {
    const box = $('quizGrades');
    if (!box || box.children.length) return;
    for (let g = 1; g <= 12; g++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'quiz-grade'; b.textContent = String(g); b.dataset.grade = String(g);
      b.addEventListener('click', () => { picked.grade = g; paint(); });
      box.appendChild(b);
    }
  }

  function paint() {
    document.querySelectorAll('.quiz-grade').forEach(b => b.classList.toggle('is-picked', Number(b.dataset.grade) === picked.grade));
    document.querySelectorAll('#quizHeard .chat-starter').forEach(b => b.classList.toggle('is-picked', b.dataset.value === picked.heard_from));
  }

  function open() {
    const u = user() || {};
    buildGrades();
    picked = { grade: u.grade || null, heard_from: u.heard_from || null };
    $('quizCity').value = u.city || '';
    $('quizGradeQ').classList.toggle('hidden', !isStudent());
    $('quizError').classList.add('hidden');
    paint();
    $('profileQuiz').classList.remove('hidden');
  }

  function close() { $('profileQuiz').classList.add('hidden'); }

  async function save() {
    const body = { city: $('quizCity').value.trim() || null, heard_from: picked.heard_from };
    if (isStudent()) body.grade = picked.grade;
    if (isStudent() && !body.grade) { say(t('quiz.needGrade')); return; }
    const res = await Net.fetch(BACKEND + '/account/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.getToken()}` },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) { say((data && data.detail) || t('account.errGeneric')); return; }
    Auth.updateUser(data);
    try { localStorage.removeItem(LATER_KEY); } catch {}
    close();
    summary();
  }

  function say(text) { const el = $('quizError'); el.textContent = text; el.classList.remove('hidden'); }

  function later() {
    try { localStorage.setItem(LATER_KEY, String(Date.now())); } catch {}
    close();
  }

  // Settings → About you: one line saying what is known
  function summary() {
    const el = $('settingsProfileSummary');
    if (!el) return;
    const u = user();
    if (!u) { el.textContent = ''; return; }
    const bits = [];
    if (u.grade) bits.push(t('quiz.gradeShort', { g: u.grade }));
    if (u.city) bits.push(u.city);
    el.textContent = bits.length ? bits.join(' · ') : t('settings.profileEmpty');
  }

  async function maybeAsk() {
    let u = user();
    if (!u || !Auth.isLoggedIn()) return;
    // a user stored before these fields existed has no way of knowing them
    if (!('grade' in u)) {
      try {
        const res = await Net.fetch(BACKEND + '/auth/me', { headers: { Authorization: `Bearer ${Auth.getToken()}` } });
        if (res.ok) { u = await res.json(); Auth.updateUser(u); }
      } catch { return; }
    }
    summary();
    if (needsAsking(u) && !snoozed()) open();
  }

  function init() {
    if (!$('profileQuiz')) return;
    document.querySelectorAll('#quizHeard .chat-starter').forEach(b => b.addEventListener('click', () => { picked.heard_from = b.dataset.value; paint(); }));
    $('quizSave').addEventListener('click', save);
    $('quizLater').addEventListener('click', later);
    const btn = $('settingsProfileBtn');
    if (btn) btn.addEventListener('click', () => { $('settingsOverlay').classList.add('hidden'); open(); });
    window.addEventListener('climby:auth-changed', e => { if (e.detail && e.detail.loggedIn) setTimeout(maybeAsk, 400); else summary(); });
    window.addEventListener('climby:user-updated', summary);
    maybeAsk();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { open };
})();

window.Profile = Profile;
