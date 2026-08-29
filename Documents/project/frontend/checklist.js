// checklist.js — списък с домашни: добавяне, отмятане, триене. Вързан към акаунта през /tasks API.
const Checklist = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  // Кой предмет е избран в долната лента. null = всички. Чете се от същия ключ,
  // който subjects.js пази, за да е верен още при първото рисуване — иначе за миг
  // се показва целият списък, преди събитието да пристигне.
  let subjectFilter = localStorage.getItem('climby-subject-filter') || null;

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
      throw new Error(t('checklist.errOffline'));
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('checklist.errSession'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(_errorMessage(data.detail));
    return data;
  }

  // Празният блок вече не е просто <p>: вътре има икона и понякога бутон.
  // Затова текстът отива в заглавието, а не върху целия контейнер.
  function setEmptyText(el, text) {
    const title = el.querySelector('.empty-title');
    if (title) title.textContent = text;
    else el.textContent = text;
  }

  function _errorMessage(detail) {
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) return detail.map(d => d.msg).join(' ');
    return t('checklist.errGeneric');
  }

  function _announceChange(result) {
    window.dispatchEvent(new CustomEvent('climby:tasks-changed'));
    return result;
  }

  function addTask(text, subject, deadline) {
    return api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ text, subject: subject || null, deadline: deadline || null }),
    }).then(_announceChange);
  }

  function setDone(id, done) {
    return api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }).then(_announceChange);
  }

  function removeTask(id) {
    return api(`/tasks/${id}`, { method: 'DELETE' }).then(_announceChange);
  }

  // Разделя една задача на по-малки стъпки през AI и ги добавя като отделни задачи.
  // Оригиналната задача се маха, за да не остане дублирана редом с частите си.
  async function splitTask(task, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('checklist.splitting');
    let steps;
    try {
      const res = await Net.fetch(BACKEND + '/plan/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: task.text, subject: task.subject, lang: I18n.get() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('checklist.splitErr'));
      steps = data.steps;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showListError(err instanceof Error ? err : new Error(t('checklist.splitErr')));
      return;
    }

    // Стъпките влизат една по една, а оригиналът пада най-накрая. Ако връзката
    // се скъса по средата, ученикът остава с половин план редом с цялата задача —
    // тоест с дублирани домашни. Затова при провал връщаме каквото сме създали.
    const created = [];
    try {
      for (const step of steps) {
        const made = await api('/tasks', {
          method: 'POST',
          body: JSON.stringify({ text: step, subject: task.subject || null, deadline: task.deadline || null }),
        });
        if (made && made.id) created.push(made.id);
      }
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      _announceChange();
    } catch (err) {
      for (const id of created) {
        try {
          await api(`/tasks/${id}`, { method: 'DELETE' });
        } catch {
          // Ако и връщането не мине, повече няма какво да направим оттук.
        }
      }
      showListError(err);
    }
  }

  // всички задачи, необходими на AI помощника за плана — само неотметнатите
  async function getPendingTasks() {
    const tasks = await api('/tasks');
    return tasks
      .filter(t => !t.done)
      .map(({ text, subject, deadline }) => ({ text, subject, deadline }));
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(dateStr + 'T00:00:00');
    return Math.round((due - today) / 86400000);
  }

  function plural(n) { return n === 1 ? t('checklist.dayOne') : t('checklist.dayMany'); }

  function deadlineLabel(dateStr) {
    const d = daysUntil(dateStr);
    if (d === null) return { text: t('checklist.noDeadline'), overdue: false, soon: false };
    if (d < 0) return { text: t('checklist.overdue', { n: Math.abs(d), days: plural(Math.abs(d)) }), overdue: true, soon: false };
    if (d === 0) return { text: t('checklist.dueToday'), overdue: false, soon: true };
    if (d === 1) return { text: t('checklist.dueTomorrow'), overdue: false, soon: true };
    return { text: t('checklist.dueIn', { n: d, days: plural(d) }), overdue: false, soon: false };
  }

  function buildTaskItem(t) {
    const dl = deadlineLabel(t.deadline);
    const li = document.createElement('li');
    li.className = 'task';

    const check = document.createElement('label');
    check.className = 'task-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = t.done;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        // кратка анимация, после задачата "заминава" към Историята (render идва от climby:tasks-changed)
        li.classList.add('task-completing');
        setTimeout(() => setDone(t.id, true).catch(showListError), 320);
      } else {
        setDone(t.id, false).catch(showListError);
      }
    });
    check.appendChild(checkbox);

    const body = document.createElement('div');
    body.className = 'task-body';
    const textEl = document.createElement('div');
    textEl.className = 'task-text';
    textEl.textContent = t.text;
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    if (t.subject) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = t.subject;
      meta.appendChild(pill);
    }
    const deadline = document.createElement('span');
    deadline.className = 'deadline' + (dl.overdue ? ' overdue' : '') + (dl.soon ? ' soon' : '');
    deadline.textContent = dl.text;
    meta.appendChild(deadline);
    body.appendChild(textEl);
    body.appendChild(meta);

    const split = document.createElement('button');
    split.type = 'button';
    split.className = 'task-split';
    split.textContent = window.t('checklist.splitBtn');
    split.addEventListener('click', () => splitTask(t, split));
    body.appendChild(split);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', window.t('checklist.deleteAria'));
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeTask(t.id).catch(showListError);
    });

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  // Броячът в менюто показва какво гори днес, за да не се налага да отваряш чеклиста,
  // за да разбереш, че нещо е просрочено.
  function updateBadge(tasks) {
    const badge = $('checklistBadge');
    if (!badge) return;
    const urgent = tasks.filter(t => {
      if (t.done || !t.deadline) return false;
      const d = daysUntil(t.deadline);
      return d !== null && d <= 0;
    }).length;
    badge.textContent = urgent > 9 ? '9+' : String(urgent);
    badge.classList.toggle('hidden', urgent === 0);
  }

  function showListError(err) {
    const empty = $('taskEmpty');
    $('taskList').innerHTML = '';
    setEmptyText(empty, err.message || t('checklist.errLoad'));
    empty.classList.remove('hidden');
  }

  let lastTasks = null;

  async function render() {
    if (!Auth.isLoggedIn()) return;
    const list = $('taskList');
    const empty = $('taskEmpty');

    if (!list.children.length) {
      setEmptyText(empty, t('checklist.loading'));
      empty.classList.remove('hidden');
    }

    let allTasks;
    try {
      allTasks = await api('/tasks');
    } catch (err) {
      showListError(err);
      return;
    }
    lastTasks = allTasks;
    updateBadge(allTasks);

    let pending = allTasks.filter(t => !t.done);
    const filtered = subjectFilter
      ? pending.filter(t => t.subject === subjectFilter)
      : pending;
    list.innerHTML = '';

    if (filtered.length === 0) {
      // Празно заради филтъра не е същото като празно изобщо — иначе изглежда, че
      // задачите са изчезнали.
      setEmptyText(empty, subjectFilter && pending.length
        ? t('checklist.emptyForSubject', { subject: subjectFilter })
        : allTasks.length === 0
          ? t('checklist.emptyDefault')
          : t('checklist.emptyAllDone'));
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const t of filtered) list.appendChild(buildTaskItem(t));
  }

  async function handleAdd(e) {
    e.preventDefault();
    const text = $('taskText').value.trim();
    if (!text) return;
    try {
      await addTask(text, $('taskSubject').value.trim(), $('taskDeadline').value);
      $('taskForm').reset();
      $('taskText').focus();
    } catch (err) {
      showListError(err);
    }
  }

  function updateGate() {
    const loggedIn = Auth.isLoggedIn();
    $('authGate').classList.toggle('hidden', loggedIn);
    $('checklistApp').classList.toggle('hidden', !loggedIn);
    if (loggedIn) {
      render();
    } else {
      $('checklistBadge').classList.add('hidden');
    }
  }

  function init() {
    $('taskForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, () => handleAdd(e));
    });
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'checklist') updateGate();
    });
    window.addEventListener('climby:subject-filter-changed', e => {
      subjectFilter = e.detail.subject;
      if (Auth.isLoggedIn()) render();
    });
    window.addEventListener('climby:tasks-changed', render);
    window.addEventListener('climby:lang-changed', () => { if (Auth.isLoggedIn()) render(); });
    updateGate();
  }

  return { init, getPendingTasks };
})();

document.addEventListener('DOMContentLoaded', Checklist.init);
