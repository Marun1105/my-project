// nav.js — превключва между секциите (Учител / Чеклист / ...) и управлява страничното меню на мобилни
(() => {
  function activate(view) {
    document.querySelectorAll('.view').forEach(el => {
      el.classList.toggle('hidden', el.id !== `view-${view}`);
    });
    document.querySelectorAll('.nav-link').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });
    document.querySelectorAll('.nav-group').forEach(group => {
      group.classList.toggle('expanded', !!group.querySelector(`.nav-link[data-view="${view}"]`));
    });
    window.dispatchEvent(new CustomEvent('climby:view-shown', { detail: { view } }));
  }

  function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.remove('hidden');
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.add('hidden');
  }

  function init() {
    document.querySelectorAll('.nav-link').forEach(btn => {
      btn.addEventListener('click', () => {
        activate(btn.dataset.view);
        closeSidebar();
      });
    });

    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) menuToggle.addEventListener('click', openSidebar);

    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.addEventListener('click', closeSidebar);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
