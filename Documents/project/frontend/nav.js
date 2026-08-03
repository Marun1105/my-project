// nav.js — превключва между секциите (Учител / Чеклист / ...)
(() => {
  function activate(view) {
    document.querySelectorAll('.view').forEach(el => {
      el.classList.toggle('hidden', el.id !== `view-${view}`);
    });
    document.querySelectorAll('.tab').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });
  }

  function init() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => activate(btn.dataset.view));
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
