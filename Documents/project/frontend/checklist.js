// checklist.js — списък с домашни: добавяне, отмятане, триене, групирани по срок
// Пази задачите в localStorage засега — стъпка 4 от плана ще ги премести в базата данни.
const Checklist = (() => {
  const $ = id => document.getElementById(id);
  const KEY = 'climby-tasks';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  }
  function save(tasks) { localStorage.setItem(KEY, JSON.stringify(tasks)); }

  function addTask(text, subject, deadline) {
    const tasks = load();
    tasks.push({ id: Date.now() + Math.random(), text, subject, deadline, done: false });
    save(tasks);
    render();
  }

  function toggleDone(id) {
    save(load().map(t => t.id === id ? { ...t, done: !t.done } : t));
    render();
  }

  function removeTask(id) {
    save(load().filter(t => t.id !== id));
    render();
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

  function render() {
    const tasks = load();
    const list = $('taskList');
    const empty = $('taskEmpty');
    list.innerHTML = '';

    if (tasks.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // недовършените първо, после по срок — най-спешното най-отгоре
    const sorted = [...tasks].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    });

    for (const t of sorted) {
      const dl = deadlineLabel(t.deadline);
      const li = document.createElement('li');
      li.className = 'task' + (t.done ? ' task-done' : '');

      const check = document.createElement('label');
      check.className = 'task-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = t.done;
      checkbox.addEventListener('change', () => toggleDone(t.id));
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
      del.addEventListener('click', () => removeTask(t.id));

      li.appendChild(check);
      li.appendChild(body);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  function handleAdd(e) {
    e.preventDefault();
    const text = $('taskText').value.trim();
    if (!text) return;
    addTask(text, $('taskSubject').value.trim(), $('taskDeadline').value);
    $('taskForm').reset();
    $('taskText').focus();
  }

  function getPendingTasks() {
    return load()
      .filter(t => !t.done)
      .map(({ text, subject, deadline }) => ({ text, subject: subject || null, deadline: deadline || null }));
  }

  function init() {
    $('taskForm').addEventListener('submit', handleAdd);
    render();
  }

  return { init, getPendingTasks };
})();

document.addEventListener('DOMContentLoaded', Checklist.init);
