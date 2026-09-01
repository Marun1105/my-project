// ai-planner.js — бутон в чеклиста, който пита AI как да се организира работата
const Planner = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  function renderAdvice(text) {
    const el = $('planAdvice');
    el.classList.remove('error', 'thinking');
    // Без DOMPurify не пускаме HTML изобщо — AI отговорът не е доверен вход.
    if (window.marked && window.DOMPurify) {
      el.innerHTML = window.aiBadgeHtml() + DOMPurify.sanitize(marked.parse(text));
    } else {
      el.innerHTML = window.aiBadgeHtml();
      const plain = document.createElement('div');
      plain.textContent = text;
      el.appendChild(plain);
    }
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
    el.innerHTML = sparkSvg('spark-spin') + ' ' + t('checklist.planThinking');

    try {
      const tasks = await Checklist.getPendingTasks();
      const res = await Net.fetch(BACKEND + '/plan', {
        // И тук отговорът се пише от AI — по-кратък от този на учителя, но пак
        // по-бавен от обикновена заявка към базата. Ползваме същия дълъг срок.
        timeout: Net.AI_TIMEOUT_MS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks, lang: I18n.get() }),
      });
      const data = await res.json().catch(() => ({}));
      el.classList.remove('thinking');
      if (!res.ok) {
        showError(typeof data.detail === 'string' && data.detail ? data.detail : t('checklist.planErrOffline'));
        return;
      }
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
    $('planBtn').addEventListener('click', () => Net.guardClick($('planBtn'), ask));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Planner.init);
