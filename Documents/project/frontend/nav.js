// nav.js — превключва между секциите (Учител / Чеклист / ...) и управлява страничното меню на мобилни
const Nav = (() => {
  function currentView() {
    const shown = [...document.querySelectorAll('.view')].find(v => !v.classList.contains('hidden'));
    return shown ? shown.id.replace(/^view-/, '') : 'tutor';
  }

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

  // Родителят няма нужда от "Клас", учителят — от "Родител". Скриваме каквото
  // не важи за ролята, вместо да го показваме и да отказваме достъп после.
  // Гост (без вход) вижда всичко: иначе менюто се променя при влизане и обърква.
  function applyRole() {
    const role = window.Auth && Auth.isLoggedIn() ? Auth.getRole() : null;
    document.querySelectorAll('.nav-group[data-role]').forEach(group => {
      const allowed = group.dataset.role.split(' ');
      const hide = !!role && !allowed.includes(role);
      group.classList.toggle('hidden', hide);
      // ако скриваме групата, в която сме, се връщаме на началния изглед
      if (hide && group.querySelector('.nav-link.active')) activate('tutor');
    });
  }

  function init() {
    applyRole();
    window.addEventListener('climby:auth-changed', applyRole);

    document.querySelectorAll('.nav-link').forEach(btn => {
      btn.addEventListener('click', () => {
        activate(btn.dataset.view);
        closeSidebar();
      });
    });

    // "Към чеклиста" / "Снимай задача" от празните екрани — водят където пише.
    document.querySelectorAll('[data-goto-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        activate(btn.dataset.gotoView);
        closeSidebar();
      });
    });

    // The corner button: everywhere but ClimbAI itself, and not while the
    // focus camera is running — it would sit on the face overlay.
    const fab = document.getElementById('aiFab');
    if (fab) {
      fab.addEventListener('click', () => { activate('tutor'); closeSidebar(); });
      const place = view => fab.classList.toggle('hidden', view === 'tutor' || document.body.classList.contains('focus-live'));
      window.addEventListener('climby:view-shown', e => place(e.detail.view));
      window.addEventListener('climby:focus-live', () => place(currentView()));
      place(currentView());
    }

    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) menuToggle.addEventListener('click', openSidebar);

    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.addEventListener('click', closeSidebar);

    // Връзките в менюто го затварят, но бутоните долу при акаунта не го правеха.
    // "Настройки", "Влез" и "Изход" всички водят някъде другаде, а страничното
    // меню оставаше отворено — върху настройките, или върху приложението,
    // след като си излязъл.
    document.querySelectorAll('.account-menu-item').forEach(btn => {
      btn.addEventListener('click', closeSidebar);
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { activate, openSidebar, closeSidebar };
})();

window.Nav = Nav;
