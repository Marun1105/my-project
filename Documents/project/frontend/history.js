// history.js — предишни домашни: довършените задачи, с дата на добавяне, срок и резултат
const History = (() => {
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
      throw new Error(t('history.errOffline'));
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('history.errSession'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t('history.errGeneric'));
    return data;
  }

  // Празният блок вече не е просто <p>: вътре има икона и бутон, така че
  // textContent би ги изтрил. Текстът отива в заглавието.
  function setEmptyText(el, text) {
    const title = el.querySelector('.empty-title');
    if (title) title.textContent = text;
    else el.textContent = text;
  }

  // Кой дял се гледа. Изборът се помни, за да не отскача обратно при връщане.
  const TAB_KEY = 'climby-history-tab';

  function showTab(which) {
    localStorage.setItem(TAB_KEY, which);
    document.querySelectorAll('[data-history-tab]').forEach(tab => {
      const on = tab.dataset.historyTab === which;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const tasks = $('historyTasksPanel');
    const scans = $('historyScansPanel');
    if (tasks) tasks.classList.toggle('hidden', which !== 'tasks');
    if (scans) scans.classList.toggle('hidden', which !== 'scans');
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

  function removeScan(id) {
    return api(`/scans/${id}`, { method: 'DELETE' });
  }

  function plural(n) { return n === 1 ? t('history.dayOne') : t('history.dayMany'); }

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
    if (n <= 0) return t('history.today');
    if (n === 1) return t('history.yesterday');
    return t('history.daysAgo', { n, days: plural(n) });
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    const locale = I18n.get() === 'en' ? 'en-GB' : 'bg-BG';
    return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function completionStatus(t) {
    if (!t.deadline || !t.completed_at) return null;
    const diff = daysBetween(t.deadline, t.completed_at);
    if (diff <= 0) return { text: window.t('history.doneOnTime'), late: false };
    return { text: window.t('history.doneLate', { n: diff, days: plural(diff) }), late: true };
  }

  function buildHistoryItem(t) {
    const li = document.createElement('li');
    li.className = 'task';

    const check = document.createElement('label');
    check.className = 'task-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.title = window.t('history.undoTitle');
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
    added.textContent = window.t('history.addedOn', { date: formatDate(t.created_at) });
    meta.appendChild(added);

    const status = completionStatus(t);
    if (status) {
      // задачата вече е свършена — дори със закъснение, тонът остава неутрален, не предупредителен
      const statusEl = document.createElement('span');
      statusEl.className = 'deadline' + (status.late ? '' : ' soon');
      statusEl.textContent = status.text;
      meta.appendChild(statusEl);
    } else if (t.completed_at) {
      const doneEl = document.createElement('span');
      doneEl.className = 'deadline soon';
      doneEl.textContent = window.t('history.doneAgo', { ago: relativeAgo(t.completed_at) });
      meta.appendChild(doneEl);
    }

    body.appendChild(textEl);
    body.appendChild(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', window.t('history.deleteAria'));
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeTask(t.id).catch(() => render());
    });

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  function buildScanItem(scan) {
    const li = document.createElement('li');
    li.className = 'task';

    const body = document.createElement('div');
    body.className = 'task-body';

    const textEl = document.createElement('div');
    textEl.className = 'task-text';
    textEl.textContent = scan.question;
    body.appendChild(textEl);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const when = document.createElement('span');
    when.className = 'deadline';
    when.textContent = window.t('history.scanAskedOn', { ago: relativeAgo(scan.created_at) });
    meta.appendChild(when);
    body.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'scan-toggle';
    toggle.textContent = window.t('history.scanViewAnswer');

    const answer = document.createElement('div');
    answer.className = 'scan-answer hidden';
    let rendered = false;
    toggle.addEventListener('click', () => {
      const open = answer.classList.toggle('hidden');
      toggle.textContent = window.t(open ? 'history.scanViewAnswer' : 'history.scanHideAnswer');
      if (!open && !rendered) {
        // отговорът е Markdown от AI — рендираме и чистим при първо отваряне, не при всеки клик.
        // Без DOMPurify не пускаме HTML изобщо: показваме го като чист текст.
        if (window.marked && window.DOMPurify) {
          answer.innerHTML = DOMPurify.sanitize(marked.parse(scan.answer));
        } else {
          answer.textContent = scan.answer;
        }
        rendered = true;
      }
    });
    body.appendChild(toggle);
    body.appendChild(answer);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', window.t('history.deleteAria'));
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeScan(scan.id).then(renderScans).catch(() => renderScans());
    });

    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  async function renderScans() {
    const list = $('scanHistoryList');
    const empty = $('scanHistoryEmpty');
    let scans;
    try {
      scans = await api('/scans');
    } catch {
      scans = [];
    }
    list.innerHTML = '';
    if (!scans.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const s of scans) list.appendChild(buildScanItem(s));
  }

  async function render() {
    if (!Auth.isLoggedIn()) return;
    renderScans();
    const list = $('historyList');
    const empty = $('historyEmpty');

    if (!list.children.length) {
      setEmptyText(empty, t('history.loading'));
      empty.classList.remove('hidden');
    }

    let tasks;
    try {
      tasks = await api('/tasks');
    } catch (err) {
      list.innerHTML = '';
      setEmptyText(empty, err.message || t('history.errLoad'));
      empty.classList.remove('hidden');
      return;
    }

    const done = tasks
      .filter(t => t.done)
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

    list.innerHTML = '';
    if (done.length === 0) {
      setEmptyText(empty, t('history.emptyDefault'));
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
    $('goToChecklistBtn').addEventListener('click', () => Auth.openEntryGate());
    window.addEventListener('climby:auth-changed', updateGate);
    window.addEventListener('climby:tasks-changed', render);
    window.addEventListener('climby:lang-changed', () => { if (Auth.isLoggedIn()) render(); });
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view === 'history') { updateGate(); showTab(localStorage.getItem(TAB_KEY) || 'tasks'); }
    });

    // Двата дяла вече не стоят един под друг, а се сменят от превключвателя.
    document.querySelectorAll('[data-history-tab]').forEach(tab => {
      tab.addEventListener('click', () => showTab(tab.dataset.historyTab));
    });
    updateGate();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', History.init);
