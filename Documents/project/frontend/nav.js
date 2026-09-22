// nav.js — превключва между секциите (Учител / Чеклист / ...) и управлява страничното меню на мобилни
const Nav = (() => {
  function currentView() {
    const shown = [...document.querySelectorAll('.view')].find(v => !v.classList.contains('hidden'));
    return shown ? shown.id.replace(/^view-/, '') : 'tutor';
  }

  // Назад. Досега бутонът "назад" — на мишката, Alt+←, жестът на телефона —
  // не правеше нищо: приложението нямаше история, всички екрани живееха на един
  // адрес. Всеки екран оставя следа, така че назад връща на предишния екран, а
  // не изхвърля човека от приложението. Стрелката се пише в адреса (#route),
  // което прави и презареждането честно: връщаш се там, където си бил.
  function activate(view, fromHistory) {
    if (!fromHistory) {
      const at = history.state && history.state.view;
      if (at === view) history.replaceState({ view }, '', '#' + view);
      else history.pushState({ view }, '', '#' + view);
    }
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

  // Кой екран е валиден за адрес — иначе #каквото-и-да-е отваря празно.
  function knownView(name) {
    return !!(name && document.getElementById('view-' + name));
  }

  function initHistory() {
    const fromUrl = (location.hash || '').replace(/^#/, '');
    const start = knownView(fromUrl) ? fromUrl : currentView();
    history.replaceState({ view: start }, '', '#' + start);
    if (start !== currentView()) activate(start, true);

    window.addEventListener('popstate', e => {
      // Отвореното странично меню е "над" екрана: назад първо затваря него.
      const sidebar = document.getElementById('sidebar');
      if (sidebar && sidebar.classList.contains('open')) {
        closeSidebar();
        history.pushState({ view: currentView() }, '', '#' + currentView());
        return;
      }
      const view = (e.state && e.state.view) || 'tutor';
      if (knownView(view)) activate(view, true);
    });
  }

  function init() {
    applyRole();
    initHistory();
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
      // The circle opens the chat (chat.js). It is on every screen, ClimbAI's own
      // included, and steps aside only while the focus camera runs.
      const place = () => fab.classList.toggle('hidden', document.body.classList.contains('focus-live'));
      window.addEventListener('climby:focus-live', place);
      place();
    }

    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) menuToggle.addEventListener('click', openSidebar);

    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.addEventListener('click', closeSidebar);

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const sidebar = document.getElementById('sidebar');
      if (sidebar && sidebar.classList.contains('open')) closeSidebar();
    });

    // Връзките в менюто го затварят, но бутоните долу при акаунта не го правеха.
    // "Настройки", "Влез" и "Изход" всички водят някъде другаде, а страничното
    // меню оставаше отворено — върху настройките, или върху приложението,
    // след като си излязъл.
    document.querySelectorAll('.account-menu-item').forEach(btn => {
      btn.addEventListener('click', closeSidebar);
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { activate, openSidebar, closeSidebar, currentView };
})();

window.Nav = Nav;
