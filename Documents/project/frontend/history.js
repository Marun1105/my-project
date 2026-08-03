// history.js — предишни домашни: довършените задачи, с дата на добавяне, срок и резултат
const History = (() => {
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
      throw new Error('Не успях да се свържа със сървъра. Провери интернета си и опитай пак.');
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error('Сесията е изтекла. Влез отново.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Нещо се обърка. Опитай пак.');
    return data;
  }

  function _announceChange() {
    window.dispatchEvent(new CustomEvent('climby:tasks-changed'));
  }

  function unmarkDone(id) {
    return api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done: false }) }).then(_announceChange);
  }

  function removeTask(id) {
    return api(`/tasks/${id}`, { method: 'DELETE' }).then(_announceChange);
  }

  function plural(n) { return n === 1 ? 'ден' : 'дни'; }

  function toDateOnly(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function daysBetween(a, b) {
    return Math.round((toDateOnly(b) - toDateOnly(a)) / 86400000);
  }

  function relativeAgo(dateStr) {
    const n = daysBetween(new Date(dateStr), new Date());
    if (n <= 0) return 'днес';
    if (n === 1) return 'вчера';
    return `преди ${n} ${plural(n)}`;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function completionStatus(t) {
    if (!t.deadline || !t.completed_at) return null;
    const diff = daysBetween(t.deadline, t.completed_at);
    if (diff <= 0) return { text: 'Довършена навреме', late: false };
    return { text: `Довършена ${diff} ${plural(diff)} след срока`, late: true };
  }

  function buildHistoryItem(t) {
    const li = document.createElement('li');
    li.className = 'task';

    const check = document.createElement('label');
    check.className = 'task-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.title = 'Върни в чеклиста';
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked) {
        li.classList.add('task-completing');
        setTimeout(() => unmarkDone(t.id).catch(() => render()), 320);
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
    const added = document.createElement('span');
    added.className = 'deadline';
    added.textContent = `Добавена ${formatDate(t.created_at)}`;
    meta.appendChild(added);

    const status = completionStatus(t);
    if (status) {
      const statusEl = document.createElement('span');
      statusEl.className = 'deadline' + (status.late ? ' overdue' : ' soon');
      statusEl.textContent = status.text;
      meta.appendChild(statusEl);
    } else if (t.completed_at) {
      const doneEl = document.createElement('span');
      doneEl.className = 'deadline soon';
      doneEl.textContent = `Довършена ${relativeAgo(t.completed_at)}`;
      meta.appendChild(doneEl);
    }

    body.appendChild(textEl);
    body.appendChild(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Премахни от историята');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeTask(t.id).catch(() => render());
    });

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  async function render() {
    if (!Auth.isLoggedIn()) return;
    const list = $('historyList');
    const empty = $('historyEmpty');

    let tasks;
    try {
      tasks = await api('/tasks');
    } catch (err) {
      list.innerHTML = '';
      empty.textContent = err.message || 'Не успях да заредя историята.';
      empty.classList.remove('hidden');
      return;
    }

    const done = tasks
      .filter(t => t.done)
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

    list.innerHTML = '';
    if (done.length === 0) {
      empty.textContent = 'Още нямаш довършени задачи — довърши нещо от чеклиста и ще се появи тук.';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const t of done) list.appendChild(buildHistoryItem(t));
  }

  function updateGate() {
    const loggedIn = Auth.isLoggedIn();
    $('historyGate').classList.toggle('hidden', loggedIn);
    $('historyApp').classList.toggle('hidden', !loggedIn);
    if (loggedIn) render();
  }

  function init() {
    $('goToChecklistBtn').addEventListener('click', () => {
      document.querySelector('.tab[data-view="checklist"]').click();
    });
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:tasks-changed', render);
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'history') updateGate();
    });
    updateGate();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', History.init);
