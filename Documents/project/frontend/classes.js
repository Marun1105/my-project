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

  // ---------- дребни помощници ----------

  // Празният блок не е само текст — вътре има икона и понякога бутон. Затова
  // надписът отива в заглавието, а не върху целия контейнер (същото като в checklist.js).
  function _setEmptyText(el, text) {
    const title = el.querySelector('.empty-title');
    if (title) title.textContent = text;
    else el.textContent = text;
  }

  // Българското единствено число не съвпада с английското по форма, затова
  // изборът се прави тук, а не с "(и)" в самия превод.
  function _plural(n, oneKey, manyKey) {
    return t(n === 1 ? oneKey : manyKey, { n });
  }

  function _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Иконките се чертаят тук, вместо да се мъкнат като файлове: взимат цвета на
  // текста наоколо и работят на всякакъв размер в двете теми.
  function _svgIcon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(d => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  const ICON_COPY = ['M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
                     'M5 15a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2'];
  const ICON_CHECK = ['M4.5 12.5 9.5 17.5 19.5 6.5'];
  const ICON_CLASS = ['M12 4.2 2.5 9 12 13.8 21.5 9z', 'M6.5 11.3V16c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-4.7'];

  // ---------- вградено потвърждение ----------

  // Браузърният confirm спира цялата страница и изглежда като чужд прозорец —
  // за дете или за учител пред клас това е стряскащо и лесно се натиска на сляпо.
  // Затова питането израства на мястото на бутона, казва какво точно ще се загуби
  // и се отменя с Escape или с "Не".
  function _wireConfirm(anchor, trigger, question, why, onYes) {
    let bar = null;

    function close() {
      if (!bar) return;
      bar.remove();
      bar = null;
      trigger.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    }

    function open() {
      if (bar) return;
      bar = _el('div', 'cls-confirm');
      bar.setAttribute('role', 'group');

      const text = _el('div', 'cls-confirm-text');
      text.appendChild(_el('strong', 'cls-confirm-question', question));
      if (why) text.appendChild(_el('span', 'cls-confirm-why', why));

      const actions = _el('div', 'cls-confirm-actions');
      const yes = _el('button', 'cls-btn cls-btn-solid', t('classes.confirmYes'));
      yes.type = 'button';
      const no = _el('button', 'cls-btn', t('classes.confirmNo'));
      no.type = 'button';

      yes.addEventListener('click', () => Net.guardClick(yes, onYes));
      no.addEventListener('click', close);
      // Escape е изходът, който всеки очаква от питане — и е единственият,
      // достъпен без да местиш пръста си от клавиатурата.
      bar.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

      actions.appendChild(no);
      actions.appendChild(yes);
      bar.appendChild(text);
      bar.appendChild(actions);
      anchor.insertAdjacentElement('afterend', bar);

      trigger.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      // Фокусът пада върху безопасния отговор: случаен Enter не трие нищо.
      no.focus();
    }

    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', open);
  }

  // ---------- копиране на кода ----------

  function _selectText(el) {
    if (!el || !window.getSelection || !document.createRange) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // navigator.clipboard иска и сигурен контекст, и разрешение. В десктопното
  // приложение схемата app:// е обявена за сигурна заради камерата, но Electron
  // там отказва всяко разрешение освен "media" — тоест точно този API може тихо
  // да откаже. Затова има втори опит през execCommand и трети, в който кодът
  // просто се маркира, за да го копира учителят сам.
  async function _copyCode(text, codeEl) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* пада към стария начин */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch { /* остава ръчното маркиране */ }
    _selectText(codeEl);
    return false;
  }

  // ---------- учител ----------

  function _statCell(value, label) {
    const cell = _el('div', 'cls-stat' + (Number(value) === 0 ? ' is-zero' : ''));
    cell.appendChild(_el('span', 'cls-stat-value', String(value)));
    cell.appendChild(_el('span', 'cls-stat-label', label));
    return cell;
  }

  // Един ученик на ред от списък с трийсет: името носи погледа, числата стоят в
  // еднакви колони, за да се четат отвесно, а просроченото не е дума в изречение,
  // а знак до името — то е единственото, заради което учителят отваря този екран.
  function _studentRow(classroom, student) {
    const row = _el('div', 'cls-student');
    const main = _el('div', 'cls-student-main');

    const ident = _el('div', 'cls-student-ident');
    ident.appendChild(_el('span', 'cls-student-name', student.display_name));
    if (student.tasks_overdue > 0) {
      ident.appendChild(_el('span', 'cls-flag',
        _plural(student.tasks_overdue, 'classes.overdueOne', 'classes.overdueMany')));
    }

    const stats = _el('div', 'cls-stats');
    stats.appendChild(_statCell(student.tasks_done, t('classes.done')));
    stats.appendChild(_statCell(student.tasks_pending, t('classes.pending')));
    stats.appendChild(_statCell(student.focus_minutes_7d, t('classes.focusLabel')));
    // Серията идва от API-то от самото начало, но досега я виждаше само родителят.
    // "3 дни подред" до едно име казва повече от всяко средно число за класа.
    stats.appendChild(_statCell(student.focus_streak_days,
      student.focus_streak_days === 1 ? t('classes.streakOne') : t('classes.streakMany')));

    const remove = _el('button', 'cls-icon-btn', '✕');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('classes.removeStudentAria', { name: student.display_name }));

    main.appendChild(ident);
    main.appendChild(stats);
    main.appendChild(remove);
    row.appendChild(main);

    _wireConfirm(main, remove,
      t('classes.confirmRemoveStudent', { name: student.display_name }),
      t('classes.confirmRemoveStudentWhy'),
      () => api(`/classes/${classroom.id}/students/${student.student_id}`, { method: 'DELETE' })
        .then(renderTeacher)
        .catch(err => _showError('classesError', err)));

    return row;
  }

  function _codeBlock(classroom) {
    const wrap = _el('div', 'cls-code-wrap');
    wrap.title = t('classes.codeTitle');

    const code = _el('span', 'cls-code', classroom.join_code);
    const copy = _el('button', 'cls-copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', t('classes.copyCodeAria'));
    copy.appendChild(_svgIcon(ICON_COPY));

    // Обратната връзка е отделен ред, а не смяна на надписа: бутонът е само
    // иконка, а екранният четец трябва да чуе резултата, не да го гадае.
    const note = _el('span', 'cls-note hidden');
    note.setAttribute('role', 'status');

    let timer = null;
    copy.addEventListener('click', async () => {
      const ok = await _copyCode(classroom.join_code, code);
      copy.replaceChildren(_svgIcon(ok ? ICON_CHECK : ICON_COPY));
      copy.classList.toggle('is-done', ok);
      note.textContent = ok ? t('classes.codeCopied') : t('classes.copyFailed');
      note.classList.remove('hidden');
      clearTimeout(timer);
      timer = setTimeout(() => {
        copy.replaceChildren(_svgIcon(ICON_COPY));
        copy.classList.remove('is-done');
        note.classList.add('hidden');
      }, 2600);
    });

    wrap.appendChild(code);
    wrap.appendChild(copy);
    return { wrap, note };
  }

  function _classCard(classroom) {
    const card = _el('section', 'cls-card');

    const head = _el('div', 'cls-card-head');

    const ident = _el('div', 'cls-card-ident');
    ident.appendChild(_el('h3', 'cls-card-name', classroom.name));
    const count = classroom.student_count != null ? classroom.student_count : classroom.students.length;
    ident.appendChild(_el('p', 'cls-card-meta',
      _plural(count, 'classes.studentCountOne', 'classes.studentCountMany')));

    const code = _codeBlock(classroom);
    const actions = _el('div', 'cls-card-actions');
    actions.appendChild(code.wrap);

    const del = _el('button', 'cls-icon-btn', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', t('classes.deleteClassAria'));
    actions.appendChild(del);

    head.appendChild(ident);
    head.appendChild(actions);
    card.appendChild(head);
    card.appendChild(code.note);

    // Изтриването наистина не отнема нищо на ученика — задачите и историята му
    // остават негови. Но на учителя му коства целия списък: класът тръгва с нов
    // код и всеки трийсет ученика трябва да влязат наново. Това не е нещо,
    // което се случва от едно случайно докосване.
    _wireConfirm(head, del,
      t('classes.confirmDeleteClass', { name: classroom.name }),
      t('classes.confirmDeleteClassWhy'),
      () => api(`/classes/${classroom.id}`, { method: 'DELETE' })
        .then(renderTeacher)
        .catch(err => _showError('classesError', err)));

    if (!classroom.students.length) {
      card.appendChild(_el('p', 'cls-students-empty', t('classes.noStudentsYet')));
    } else {
      const list = _el('div', 'cls-students');
      classroom.students
        .slice()
        .sort((a, b) => b.tasks_overdue - a.tasks_overdue || a.display_name.localeCompare(b.display_name))
        .forEach(s => list.appendChild(_studentRow(classroom, s)));
      card.appendChild(list);
    }
    return card;
  }

  async function renderTeacher() {
    _clearError('classesError');
    const list = $('classesList');
    const empty = $('classesEmpty');

    // Безплатният Render заспива и се буди по цяла минута. Дотогава екранът
    // стоеше празен под формата, все едно учителят няма класове — а той просто
    // чака. Ако вече има карти, те остават: презареждането не е зареждане.
    if (!list.children.length) {
      _setEmptyText(empty, t('classes.loading'));
      empty.classList.remove('hidden');
    }

    let classrooms;
    try {
      classrooms = await api('/classes');
    } catch (err) {
      // "Не успях да заредя" не е "нямаш класове". Старите карти падат, за да не
      // висят под грешката като нещо още вярно, а на тяхно място стои причината.
      list.innerHTML = '';
      _setEmptyText(empty, err.message || t('classes.errLoad'));
      empty.classList.remove('hidden');
      return;
    }

    list.innerHTML = '';
    classrooms.forEach(c => list.appendChild(_classCard(c)));
    _setEmptyText(empty, t('classes.emptyTeacher'));
    empty.classList.toggle('hidden', classrooms.length > 0);
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
    const list = $('studentClassesList');
    const empty = $('studentClassesEmpty');

    if (!list.children.length) {
      _setEmptyText(empty, t('classes.loading'));
      empty.classList.remove('hidden');
    }

    let mine;
    try {
      mine = await api('/classes/mine');
    } catch (err) {
      list.innerHTML = '';
      _setEmptyText(empty, err.message || t('classes.errLoad'));
      empty.classList.remove('hidden');
      return;
    }

    list.innerHTML = '';

    mine.forEach(item => {
      const row = _el('div', 'class-student');
      row.appendChild(_el('span', 'class-student-name', item.name));
      row.appendChild(_el('span', 'class-student-stats', t('classes.teacherIs', { name: item.teacher_name })));

      const leave = _el('button', 'btn-ghost class-leave', t('classes.leaveBtn'));
      leave.type = 'button';
      leave.addEventListener('click', () => {
        api(`/classes/mine/${item.class_id}`, { method: 'DELETE' })
          .then(renderStudent)
          .catch(err => _showError('studentClassesError', err));
      });

      row.appendChild(leave);
      list.appendChild(row);
    });

    _setEmptyText(empty, t('classes.emptyStudent'));
    empty.classList.toggle('hidden', mine.length > 0);
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

  let _roleNote = null;

  // "Клас" не стои в менюто на родителя, но стар адрес или бутон "иди на…" го
  // докарват дотук — и трите блока се скриваха, тоест оставаше бяла страница,
  // която изглежда като счупено приложение. По-честно е да пише защо е празно
  // и накъде да продължи.
  function _renderRoleNote(show, role) {
    if (!_roleNote) {
      if (!show) return;
      const box = _el('div', 'empty-state cls-role-note');
      const icon = _el('span', 'empty-icon');
      icon.appendChild(_svgIcon(ICON_CLASS));
      const title = _el('p', 'empty-title');
      const body = _el('p', 'cls-role-body');
      const cta = _el('button', 'empty-cta');
      cta.type = 'button';
      cta.addEventListener('click', () => Nav.activate('family'));
      box.appendChild(icon);
      box.appendChild(title);
      box.appendChild(body);
      box.appendChild(cta);
      document.getElementById('view-classes').appendChild(box);
      _roleNote = { box, title, body, cta };
    }
    _roleNote.box.classList.toggle('hidden', !show);
    if (!show) return;
    _roleNote.title.textContent = t('classes.otherRoleTitle');
    _roleNote.body.textContent = t('classes.otherRoleBody');
    _roleNote.cta.textContent = t('classes.otherRoleCta');
    // Пътят напред го има само за родител — на друга роля не му предлагаме врата,
    // която и без това ще е заключена.
    _roleNote.cta.classList.toggle('hidden', role !== 'parent');
  }

  function updateGate() {
    const loggedIn = Auth.isLoggedIn();
    const role = loggedIn ? Auth.getRole() : null;
    const isTeacher = role === 'teacher';
    const isStudent = role === 'student';

    $('classesGate').classList.toggle('hidden', loggedIn);
    $('teacherApp').classList.toggle('hidden', !isTeacher);
    $('studentClassesApp').classList.toggle('hidden', !isStudent);
    _renderRoleNote(loggedIn && !isTeacher && !isStudent, role);

    if (isTeacher) renderTeacher();
    else if (isStudent) renderStudent();
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
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'classes') updateGate();
    });
    window.addEventListener('climby:lang-changed', () => { if (Auth.isLoggedIn()) updateGate(); });
    updateGate();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Classes.init);
