// ai-planner.js — бутон в чеклиста, който пита AI как да се организира работата
const Planner = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  function renderAdvice(text) {
    const el = $('planAdvice');
    el.classList.remove('error', 'thinking');
    const body = window.marked ? marked.parse(text) : text;
    el.innerHTML = window.aiBadgeHtml() + body;
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
    el.innerHTML = '<span class="spark-spin">✨</span> ' + t('checklist.planThinking');

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
