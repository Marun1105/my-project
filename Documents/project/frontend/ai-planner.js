// ai-planner.js — бутон в чеклиста, който пита AI как да се организира работата
const Planner = (() => {
  const $ = id => document.getElementById(id);
  // Адресът на бекенда. Локално смени с http://127.0.0.1:8000
  const BACKEND = 'https://my-project-0gyk.onrender.com';

  function renderAdvice(text) {
    const el = $('planAdvice');
    el.classList.remove('error', 'thinking');
    el.innerHTML = window.marked ? marked.parse(text) : text;
  }

  function showError(text) {
    const el = $('planAdvice');
    el.classList.remove('thinking');
    el.classList.add('error');
    el.textContent = text;
  }

  async function ask() {
    const el = $('planAdvice');
    el.classList.remove('hidden', 'error');
    el.classList.add('thinking');
    el.textContent = t('checklist.planThinking');

    try {
      const tasks = await Checklist.getPendingTasks();
      const res = await fetch(BACKEND + '/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks, lang: I18n.get() }),
      });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      el.classList.remove('thinking');
      if (data.advice) {
        renderAdvice(data.advice);
      } else {
        showError(t('checklist.planErrEmpty'));
      }
    } catch (err) {
      showError(t('checklist.planErrOffline'));
    }
  }

  function init() {
    $('planBtn').addEventListener('click', ask);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Planner.init);
