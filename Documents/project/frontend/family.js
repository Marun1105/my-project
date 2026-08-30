// family.js — родителски изглед: свързване с ученик през код и обобщен напредък.
// Съзнателно показва само числа: текстът на задачите и въпросите остава личен за ученика.
const Family = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  async function api(path, options = {}) {
    const token = Auth.getToken();
    let res;
    try {
      res = await Net.fetch(BACKEND + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new Error(t('family.errGeneric'));
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('family.errGeneric'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('family.errGeneric'));
    return data;
  }

  // Празният блок носи икона и заглавие, затова надписът отива в заглавието,
  // а не върху целия контейнер (същото като в checklist.js).
  function setEmptyText(el, text) {
    const title = el.querySelector('.empty-title');
    if (title) title.textContent = text;
    else el.textContent = text;
  }

  // Отпаднала заявка не е отговор. Съобщението застава до списъка, вместо
  // списъкът да бъде изтрит и на негово място да се появи твърдение.
  function inlineError(after, key) {
    let el = after.nextElementSibling;
    if (!el || !el.classList.contains('family-load-error')) {
      el = document.createElement('p');
      el.className = 'hint auth-error family-load-error';
      after.insertAdjacentElement('afterend', el);
    }
    el.textContent = t(key);
    el.classList.remove('hidden');
    return el;
  }

  function clearInlineError(after) {
    const el = after.nextElementSibling;
    if (el && el.classList.contains('family-load-error')) el.classList.add('hidden');
  }

  function statCell(label, value, tone) {
    const cell = document.createElement('div');
    cell.className = 'family-stat' + (tone ? ` ${tone}` : '');
    const v = document.createElement('div');
    v.className = 'family-stat-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'family-stat-label';
    l.textContent = label;
    cell.appendChild(v);
    cell.appendChild(l);
    return cell;
  }

  function buildStudentCard(s) {
    const card = document.createElement('div');
    card.className = 'family-card';

    const head = document.createElement('div');
    head.className = 'family-card-head';
    const name = document.createElement('span');
    name.className = 'family-card-name';
    name.textContent = s.display_name;
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'task-delete';
    unlink.setAttribute('aria-label', t('family.unlinkBtn'));
    unlink.textContent = '✕';
    unlink.addEventListener('click', async () => {
      try {
        await api(`/family/students/${s.student_id}`, { method: 'DELETE' });
        render();
      } catch { render(); }
    });
    head.appendChild(name);
    head.appendChild(unlink);

    const stats = document.createElement('div');
    stats.className = 'family-stats';
    stats.appendChild(statCell(t('family.tasksDone'), s.tasks_done));
    stats.appendChild(statCell(t('family.tasksPending'), s.tasks_pending));
    stats.appendChild(statCell(t('family.tasksOverdue'), s.tasks_overdue, s.tasks_overdue > 0 ? 'warn' : ''));
    stats.appendChild(statCell(t('family.focusWeek'), t('family.minutesShort', { n: s.focus_minutes_7d })));
    stats.appendChild(statCell(t('family.streak'), s.focus_streak_days));

    card.appendChild(head);
    card.appendChild(stats);
    return card;
  }

  async function renderStudents() {
    const wrap = $('familyStudents');
    const empty = $('familyStudentsEmpty');

    // Сървърът се буди по минута; дотогава родителят не бива да чете, че няма дете.
    if (!wrap.children.length) {
      setEmptyText(empty, t('family.loading'));
      empty.classList.remove('hidden');
    }

    let students;
    try {
      students = await api('/family/students');
    } catch {
      // Тук стоеше students = [], тоест паднал интернет се показваше като
      // "Още нямаш свързан ученик" — приложението отричаше връзка, която си
      // има. Каквото вече се вижда, остава; отдолу пише, че не сме се свързали.
      inlineError(wrap, 'family.errLoadStudents');
      if (!wrap.children.length) empty.classList.add('hidden');
      return;
    }

    clearInlineError(wrap);
    wrap.innerHTML = '';
    setEmptyText(empty, t('family.noStudents'));
    empty.classList.toggle('hidden', students.length > 0);
    for (const s of students) wrap.appendChild(buildStudentCard(s));
  }

  async function renderParents() {
    const wrap = $('familyParents');
    let parents;
    try {
      parents = await api('/family/parents');
    } catch {
      // Липсващият списък казва "никой няма достъп до данните ти" — точно
      // обратното на истината, ако заявката просто не е стигнала.
      inlineError(wrap, 'family.errLoadParents');
      return;
    }
    clearInlineError(wrap);
    wrap.innerHTML = '';
    if (!parents.length) return;

    const title = document.createElement('h3');
    title.className = 'history-section-title';
    title.textContent = t('family.parentsTitle');
    wrap.appendChild(title);

    for (const p of parents) {
      const row = document.createElement('div');
      row.className = 'family-parent-row';
      const name = document.createElement('span');
      name.textContent = p.display_name;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'scan-toggle';
      revoke.textContent = t('family.revokeBtn');
      revoke.addEventListener('click', async () => {
        try {
          await api(`/family/parents/${p.parent_id}`, { method: 'DELETE' });
          renderParents();
        } catch { renderParents(); }
      });
      row.appendChild(name);
      row.appendChild(revoke);
      wrap.appendChild(row);
    }
  }

  function render() {
    renderStudents();
    renderParents();
  }

  function showLinkError(msg) {
    const el = $('familyLinkError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  async function handleLink(e) {
    e.preventDefault();
    $('familyLinkError').classList.add('hidden');
    const code = $('familyCodeInput').value.trim();
    if (!code) return;
    try {
      await api('/family/link', { method: 'POST', body: JSON.stringify({ code }) });
      $('familyCodeInput').value = '';
      render();
    } catch (err) {
      showLinkError(err.message);
    }
  }

  async function handleInvite() {
    const el = $('familyInviteCode');
    try {
      const data = await api('/family/invite', { method: 'POST' });
      el.textContent = t('family.codeReady', { code: data.code });
      el.classList.remove('hidden');
    } catch (err) {
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  }

  function updateGate() {
    const loggedIn = Auth.isLoggedIn();
    $('familyGate').classList.toggle('hidden', loggedIn);
    $('familyApp').classList.toggle('hidden', !loggedIn);
    if (loggedIn) render();
  }

  function init() {
    $('familyLoginBtn').addEventListener('click', () => Auth.openEntryGate());
    $('familyLinkForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, () => handleLink(e));
    });
    $('familyInviteBtn').addEventListener('click', handleInvite);
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:lang-changed', () => { if (Auth.isLoggedIn()) render(); });
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'family') updateGate();
    });
    updateGate();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Family.init);
