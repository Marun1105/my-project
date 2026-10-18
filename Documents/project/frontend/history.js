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

  // Изгледът може да стои скрит зад друг раздел. nav.js маха класа 'hidden'
  // преди да обяви climby:view-shown, така че проверката е винаги актуална.
  function isVisible() {
    const view = document.getElementById('view-history');
    return !!view && !view.classList.contains('hidden');
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
    // Сканиранията се теглят чак когато дялът им се отвори. Преди това всяко
    // отмятане на задача дърпаше и /scans — за списък, който никой не гледа.
    if (which === 'scans' && Auth.isLoggedIn()) renderScans();
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
    // a record without a date says nothing rather than "Invalid Date"
    if (t.created_at && !isNaN(new Date(t.created_at))) {
      const added = document.createElement('span');
      added.className = 'deadline';
      added.textContent = window.t('history.addedOn', { date: formatDate(t.created_at) });
      meta.appendChild(added);
    }

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
        // The same maths the tutor showed: without this a saved answer read
        // "$rac{3}{4}$" where the student had seen a fraction.
        if (window.renderMathInElement) {
          renderMathInElement(answer, {
            delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
            throwOnError: false,
          });
        }
        rendered = true;
      }
    });
    // Carry on where it stopped: the question and answer open as a chat.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'scan-toggle scan-continue';
    more.textContent = window.t('history.continueChat');
    more.addEventListener('click', () => {
      if (window.Chat) Chat.startFrom([{ role: 'user', text: scan.question }, { role: 'assistant', text: scan.answer }]);
    });
    const actions = document.createElement('div');
    actions.className = 'scan-actions';
    actions.append(toggle, more);
    body.appendChild(actions);
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

  // Three numbers above the list: how many are done, how many of those with a
  // deadline were done in time, and how many this week. Effort, counted; a late
  // one is not a mark against anybody, so the second number only counts tasks
  // that had a deadline at all.
  function renderStats(done) {
    const box = $('historyStats');
    if (!box) return;
    if (!done.length) { box.classList.add('hidden'); return; }
    const dated = done.filter(x => x.deadline && x.completed_at);
    const onTime = dated.filter(x => daysBetween(x.deadline, x.completed_at) <= 0).length;
    const weekAgo = Date.now() - 7 * 86400000;
    const week = done.filter(x => x.completed_at && new Date(x.completed_at).getTime() >= weekAgo).length;
    const cells = [
      [String(done.length), window.t('history.statDone')],
      [dated.length ? Math.round((100 * onTime) / dated.length) + '%' : '—', window.t('history.statOnTime')],
      [String(week), window.t('history.statWeek')],
    ];
    box.textContent = '';
    for (const [value, label] of cells) {
      const cell = document.createElement('div');
      cell.className = 'stat-cell';
      const v = document.createElement('span');
      v.className = 'stat-value';
      v.textContent = value;
      const l = document.createElement('span');
      l.className = 'stat-label';
      l.textContent = label;
      cell.append(v, l);
      box.appendChild(cell);
    }
    box.classList.remove('hidden');
  }

  // Чия сметка е нарисувана в момента на екрана. Таблетът е семеен и минава от
  // ръка на ръка — щом влезе друг, чуждите домашни трябва да изчезнат веднага,
  // а не когато сървърът отговори (буден Render се бави и минута).
  let renderedFor = null;
  // Всяко рисуване си носи номер. Изпревари ли го по-ново, старият отговор се
  // изхвърля — иначе изтрита задача се появява пак, защото по-бавната заявка е
  // тръгнала преди триенето и се връща след него.
  let tasksSeq = 0;
  let scansSeq = 0;

  function dropForeignRows() {
    const account = Auth.getToken();
    if (renderedFor === account) return;
    renderedFor = account;
    $('historyList').innerHTML = '';
    $('scanHistoryList').innerHTML = '';
  }

  // The chats kept on this device, newest first: press one and it opens.
  function renderChats() {
    const box = $('historyChats');
    const host = $('historyChatList');
    if (!box || !host || !window.Chat) return;
    const chats = Chat.list();
    box.classList.toggle('hidden', !chats.length);
    host.textContent = '';
    for (const c of chats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-chat';
      const icon = document.createElement('span');
      icon.className = 'history-chat-icon';
      icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'history-chat-title';
      title.textContent = c.title || window.t('chat.untitled');
      const meta = document.createElement('span');
      meta.className = 'history-chat-meta';
      const n = Math.ceil(c.turns / 2);
      meta.textContent = window.t(n === 1 ? 'history.chatMetaOne' : 'history.chatMeta', { n, ago: relativeAgo(new Date(c.updated).toISOString()) });
      const text = document.createElement('span');
      text.className = 'history-chat-text';
      text.append(title, meta);
      btn.append(icon, text);
      btn.addEventListener('click', () => Chat.openThread(c.id));
      host.appendChild(btn);
    }
  }

  async function renderScans() {
    renderChats();
    const list = $('scanHistoryList');
    const empty = $('scanHistoryEmpty');
    const seq = ++scansSeq;
    dropForeignRows();
    let scans;
    try {
      scans = await api('/scans');
    } catch {
      scans = [];
    }
    if (seq !== scansSeq) return; // изпреварени сме от по-ново рисуване
    list.innerHTML = '';
    // Saved chats and no account questions yet: the chats are the answer to
    // "have I asked anything", so the empty screen would contradict them.
    const hasChats = !!(window.Chat && Chat.list().length);
    if ($('historyEarlierTitle')) $('historyEarlierTitle').classList.toggle('hidden', !scans.length);
    if (!scans.length) {
      empty.classList.toggle('hidden', hasChats);
      return;
    }
    empty.classList.add('hidden');
    for (const s of scans) list.appendChild(buildScanItem(s));
  }

  async function render() {
    if (!Auth.isLoggedIn()) return;
    // Скрит изглед не се рисува: иначе едно отмятане в чеклиста теглеше и
    // /tasks, и /scans за екран, който никой не гледа. Връщането тук минава
    // през climby:view-shown, който рисува наново — така Историята никога не
    // пристига остаряла.
    if (!isVisible()) return;

    const list = $('historyList');
    const empty = $('historyEmpty');
    const seq = ++tasksSeq;
    dropForeignRows();

    if (!list.children.length) {
      if (window.AIActivity) AIActivity.fillLoading(empty, t('history.loading'));
      else setEmptyText(empty, t('history.loading'));
      empty.classList.remove('hidden');
    }

    let tasks;
    try {
      tasks = await api('/tasks');
    } catch (err) {
      if (seq !== tasksSeq) return;
      list.innerHTML = '';
      setEmptyText(empty, err.message || t('history.errLoad'));
      empty.classList.remove('hidden');
      return;
    }
    if (seq !== tasksSeq) return;
    // Броячът в менюто се вижда и оттук — подаваме му вече изтеглените задачи,
    // за да не прави чеклистът втора заявка за същото.
    if (window.Checklist && typeof Checklist.syncBadge === 'function') Checklist.syncBadge(tasks);

    const done = tasks
      .filter(t => t.done)
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
    renderStats(done);

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
    if (loggedIn) {
      render();
    } else {
      // Домашните на предишния ученик си отиват заедно с него, а не чакат
      // следващия да дочете списъка, докато сървърът се събужда.
      $('historyList').innerHTML = '';
      $('scanHistoryList').innerHTML = '';
      if ($('historyChatList')) $('historyChatList').textContent = '';
      if ($('historyChats')) $('historyChats').classList.add('hidden');
      if ($('historyStats')) $('historyStats').classList.add('hidden');
      $('historyEmpty').classList.add('hidden');
      $('scanHistoryEmpty').classList.add('hidden');
      renderedFor = null;
      tasksSeq++; // отговор по вече тръгнала заявка от старата сметка не важи
      scansSeq++;
    }
  }

  function init() {
    window.addEventListener('climby:chats-changed', () => {
      if (Auth.isLoggedIn() && !$('historyScansPanel').classList.contains('hidden')) renderChats();
    });
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

  return { init, relativeAgo };
})();

document.addEventListener('DOMContentLoaded', History.init);

window.History = History;
