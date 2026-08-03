// checklist.js — списък с домашни: добавяне, отмятане, триене. Вързан към акаунта през /tasks API.
const Checklist = (() => {
  const $ = id => document.getElementById(id);
  // Адресът на бекенда. Локално смени с http://127.0.0.1:8000
  const BACKEND = 'https://my-project-0gyk.onrender.com';

  async function api(path, options = {}) {
    const token = Auth.getToken();
    let res;
    try {
      res = await fetch(BACKEND + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new Error('Не успях да се свържа със сървъра. Провери интернета си и опитай пак — нищо не е загубено.');
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error('Сесията е изтекла. Влез отново.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(_errorMessage(data.detail));
    return data;
  }

  function _errorMessage(detail) {
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) return detail.map(d => d.msg).join(' ');
    return 'Нещо се обърка. Опитай пак.';
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

  function plural(n) { return n === 1 ? 'ден' : 'дни'; }

  function deadlineLabel(dateStr) {
    const d = daysUntil(dateStr);
    if (d === null) return { text: 'Без срок', overdue: false, soon: false };
    if (d < 0) return { text: `Просрочено с ${Math.abs(d)} ${plural(Math.abs(d))}`, overdue: true, soon: false };
    if (d === 0) return { text: 'Днес', overdue: false, soon: true };
    if (d === 1) return { text: 'Утре', overdue: false, soon: true };
    return { text: `След ${d} ${plural(d)}`, overdue: false, soon: false };
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

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Изтрий задачата');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeTask(t.id).catch(showListError);
    });

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  function showListError(err) {
    const empty = $('taskEmpty');
    $('taskList').innerHTML = '';
    empty.textContent = err.message || 'Не успях да заредя задачите.';
    empty.classList.remove('hidden');
  }

  async function render() {
    if (!Auth.isLoggedIn()) return;
    const list = $('taskList');
    const empty = $('taskEmpty');

    let allTasks;
    try {
      allTasks = await api('/tasks');
    } catch (err) {
      showListError(err);
      return;
    }

    const pending = allTasks.filter(t => !t.done);
    list.innerHTML = '';

    if (pending.length === 0) {
      empty.textContent = allTasks.length === 0
        ? 'Няма добавени задачи още — добави първата отгоре.'
        : 'Всичко е отметнато — чисто небе! Виж „История“, за да видиш какво си свършил.';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const t of pending) list.appendChild(buildTaskItem(t));
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
    if (loggedIn) render();
  }

  function init() {
    $('taskForm').addEventListener('submit', handleAdd);
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:tasks-changed', render);
    updateGate();
  }

  return { init, getPendingTasks };
})();

document.addEventListener('DOMContentLoaded', Checklist.init);
