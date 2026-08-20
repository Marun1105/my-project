// subjects.js — долна лента с предмети: филтрира чеклиста по предмет.
// Предметите НЕ са твърд списък — идват от реалните задачи на ученика
// (Checklist.getPendingTasks, същото API, което ползва ai-planner.js).
// Ако контейнерът #subjectBar още не е в страницата, скриптът просто не прави нищо.
const Subjects = (() => {
  const STORAGE_KEY = 'climby-subject-filter';
  const EVENT = 'climby:subject-filter-changed';

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY) || null; }
    catch { return null; }
  }

  function setStored(subject) {
    try {
      if (subject) localStorage.setItem(STORAGE_KEY, subject);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage може да липсва (private mode и т.н.) — филтърът просто не
      // преживява презареждане, но лентата продължава да работи в сесията.
    }
  }

  let selected = getStored();
  // пази последната обявена стойност, за да не пращаме едно и също събитие
  // повторно при всеки render (напр. смяна на език не пипа филтъра)
  let lastNotified;

  function notify() {
    if (selected === lastNotified) return;
    lastNotified = selected;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { subject: selected } }));
  }

  function label(key, fallback) {
    return (typeof window.t === 'function') ? window.t(key) : fallback;
  }

  // събира различните стойности на task.subject от неотметнатите задачи —
  // това е точно списъкът, който чеклистът реално показва в момента
  async function collectSubjects() {
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) return [];
    if (typeof Checklist === 'undefined' || typeof Checklist.getPendingTasks !== 'function') return [];
    let tasks;
    try {
      tasks = await Checklist.getPendingTasks();
    } catch {
      return [];
    }
    const set = new Set();
    for (const task of tasks || []) {
      const subj = task && task.subject ? String(task.subject).trim() : '';
      if (subj) set.add(subj);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'bg'));
  }

  function applyActiveState(bar) {
    bar.querySelectorAll('.subject-chip').forEach(btn => {
      const active = (btn.dataset.subject || null) === selected;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function selectSubject(bar, subject) {
    selected = subject || null;
    setStored(selected);
    applyActiveState(bar);
    notify();
  }

  function buildChip(bar, text, subjectValue) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'subject-chip';
    btn.textContent = text;
    btn.dataset.subject = subjectValue || '';
    btn.addEventListener('click', () => selectSubject(bar, subjectValue || null));
    return btn;
  }

  async function render() {
    const bar = document.getElementById('subjectBar');
    if (!bar) return; // контейнерът още не е добавен в index.html — нищо не правим

    const subjects = await collectSubjects();

    if (subjects.length === 0) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      if (selected !== null) {
        selected = null;
        setStored(null);
      }
      notify();
      return;
    }

    // избран предмет, който вече няма чакащи задачи — филтърът се нулира,
    // иначе лентата показва "Всички" активно, но чеклистът остава филтриран
    if (selected && !subjects.includes(selected)) {
      selected = null;
      setStored(null);
    }

    bar.innerHTML = '';
    bar.classList.remove('hidden');

    const track = document.createElement('div');
    track.className = 'subject-bar-track';
    track.appendChild(buildChip(bar, label('subjects.all', 'Всички'), ''));
    for (const subj of subjects) {
      track.appendChild(buildChip(bar, subj, subj));
    }
    bar.appendChild(track);
    applyActiveState(bar);
    notify();
  }

  function init() {
    const bar = document.getElementById('subjectBar');
    if (!bar) return;

    render();
    window.addEventListener('climby:tasks-changed', render);
    window.addEventListener('climby:auth-changed', render);
    window.addEventListener('climby:lang-changed', render);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Subjects.init);
