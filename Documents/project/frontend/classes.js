// classes.js — класове: учителят ги прави и следи, ученикът се присъединява с код.
// Един изглед, две лица — кое се показва зависи от ролята на акаунта.
const Classes = (() => {
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
      throw new Error(t('classes.errOffline'));
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('classes.errSession'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(_errorMessage(data.detail));
    return data;
  }

  function _errorMessage(detail) {
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) return detail.map(d => d.msg).join(' ');
    return t('classes.errGeneric');
  }

  function _showError(elId, err) {
    const el = $(elId);
    el.textContent = err.message || t('classes.errGeneric');
    el.classList.remove('hidden');
  }

  function _clearError(elId) { $(elId).classList.add('hidden'); }

  // ---------- учител ----------

  function _statRow(student) {
    const row = document.createElement('div');
    row.className = 'class-student';

    const name = document.createElement('span');
    name.className = 'class-student-name';
    name.textContent = student.display_name;

    const stats = document.createElement('span');
    stats.className = 'class-student-stats';
    const parts = [
      `${student.tasks_done} ${t('classes.done')}`,
      `${student.tasks_pending} ${t('classes.pending')}`,
    ];
    if (student.tasks_overdue > 0) parts.push(`${student.tasks_overdue} ${t('classes.overdue')}`);
    parts.push(t('classes.focusMinutes', { n: student.focus_minutes_7d }));
    stats.textContent = parts.join(' · ');
    if (student.tasks_overdue > 0) stats.classList.add('has-overdue');

    row.appendChild(name);
    row.appendChild(stats);
    return row;
  }

  function _classCard(classroom) {
    const card = document.createElement('section');
    card.className = 'class-card';

    const head = document.createElement('header');
    head.className = 'class-card-head';

    const title = document.createElement('h3');
    title.className = 'class-card-name';
    title.textContent = classroom.name;

    const code = document.createElement('span');
    code.className = 'class-code';
    code.textContent = classroom.join_code;
    code.title = t('classes.codeTitle');

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', t('classes.deleteClassAria'));
    del.textContent = '✕';
    del.addEventListener('click', () => {
      // класът се трие без питане само защото нищо на ученика не се губи —
      // задачите и историята му остават негови, пада само видимостта за учителя
      api(`/classes/${classroom.id}`, { method: 'DELETE' })
        .then(renderTeacher)
        .catch(err => _showError('classesError', err));
    });

    head.appendChild(title);
    head.appendChild(code);
    head.appendChild(del);
    card.appendChild(head);

    if (!classroom.students.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = t('classes.noStudentsYet');
      card.appendChild(empty);
    } else {
      classroom.students
        .slice()
        .sort((a, b) => b.tasks_overdue - a.tasks_overdue || a.display_name.localeCompare(b.display_name))
        .forEach(s => card.appendChild(_statRow(s)));
    }
    return card;
  }

  async function renderTeacher() {
    _clearError('classesError');
    let classrooms;
    try {
      classrooms = await api('/classes');
    } catch (err) {
      _showError('classesError', err);
      return;
    }
    const list = $('classesList');
    list.innerHTML = '';
    $('classesEmpty').classList.toggle('hidden', classrooms.length > 0);
    classrooms.forEach(c => list.appendChild(_classCard(c)));
  }

  async function handleCreate(e) {
    e.preventDefault();
    const name = $('classNameInput').value.trim();
    if (!name) return;
    try {
      await api('/classes', { method: 'POST', body: JSON.stringify({ name }) });
      $('classCreateForm').reset();
      renderTeacher();
    } catch (err) {
      _showError('classesError', err);
    }
  }

  // ---------- ученик ----------

  async function renderStudent() {
    _clearError('studentClassesError');
    let mine;
    try {
      mine = await api('/classes/mine');
    } catch (err) {
      _showError('studentClassesError', err);
      return;
    }
    const list = $('studentClassesList');
    list.innerHTML = '';
    $('studentClassesEmpty').classList.toggle('hidden', mine.length > 0);

    mine.forEach(item => {
      const row = document.createElement('div');
      row.className = 'class-student';

      const name = document.createElement('span');
      name.className = 'class-student-name';
      name.textContent = item.name;

      const teacher = document.createElement('span');
      teacher.className = 'class-student-stats';
      teacher.textContent = t('classes.teacherIs', { name: item.teacher_name });

      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'btn-ghost class-leave';
      leave.textContent = t('classes.leaveBtn');
      leave.addEventListener('click', () => {
        api(`/classes/mine/${item.class_id}`, { method: 'DELETE' })
          .then(renderStudent)
          .catch(err => _showError('studentClassesError', err));
      });

      row.appendChild(name);
      row.appendChild(teacher);
      row.appendChild(leave);
      list.appendChild(row);
    });
  }

  async function handleJoin(e) {
    e.preventDefault();
    const code = $('classCodeInput').value.trim();
    if (!code) return;
    try {
      await api('/classes/join', { method: 'POST', body: JSON.stringify({ code }) });
      $('classJoinForm').reset();
      renderStudent();
    } catch (err) {
      _showError('studentClassesError', err);
    }
  }

  // ---------- кое да се покаже ----------

  function updateGate() {
    const loggedIn = Auth.isLoggedIn();
    const isTeacher = loggedIn && Auth.getRole() === 'teacher';
    $('classesGate').classList.toggle('hidden', loggedIn);
    $('teacherApp').classList.toggle('hidden', !isTeacher);
    // родителят няма класове — за него този изглед просто не се показва в менюто
    $('studentClassesApp').classList.toggle('hidden', !loggedIn || Auth.getRole() !== 'student');

    if (isTeacher) renderTeacher();
    else if (loggedIn && Auth.getRole() === 'student') renderStudent();
  }

  function init() {
    $('classCreateForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, () => handleCreate(e));
    });
    $('classJoinForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, () => handleJoin(e));
    });
    $('classesLoginBtn').addEventListener('click', () => Auth.openEntryGate());
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:lang-changed', () => { if (Auth.isLoggedIn()) updateGate(); });
    updateGate();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Classes.init);
