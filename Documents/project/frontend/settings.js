// settings.js — акаунт менюто (аватар/име, вход/изход) в долния ляв ъгъл на sidebar-а,
// и модалът с настройки (тема + език), отворен от там. Самите тема/език логики си остават
// в theme.js/i18n.js — тук само местим кой бутон ги отваря.
const AccountUI = (() => {
  const $ = id => document.getElementById(id);

  function isMenuOpen() { return !$('accountMenu').classList.contains('hidden'); }

  function closeMenu() {
    $('accountMenu').classList.add('hidden');
    $('accountBtn').setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if (isMenuOpen()) { closeMenu(); return; }
    $('accountMenu').classList.remove('hidden');
    $('accountBtn').setAttribute('aria-expanded', 'true');
  }

  function openSettings() {
    closeMenu();
    $('settingsOverlay').classList.remove('hidden');
  }

  function closeSettings() {
    $('settingsOverlay').classList.add('hidden');
  }

  function updateAccount() {
    const user = Auth.getUser();
    const avatar = $('accountAvatar');
    const name = $('accountName');

    if (user) {
      const initial = (user.display_name || '?').trim().charAt(0).toUpperCase();
      avatar.textContent = initial || '?';
      name.removeAttribute('data-i18n');
      name.textContent = user.display_name;
    } else {
      avatar.textContent = '?';
      name.setAttribute('data-i18n', 'account.guest');
      name.textContent = t('account.guest');
    }
    $('menuLoginBtn').classList.toggle('hidden', !!user);
    $('logoutBtn').classList.toggle('hidden', !user);
  }

  function init() {
    updateAccount();
    window.addEventListener('climby:auth-changed', updateAccount);
    window.addEventListener('climby:lang-changed', updateAccount);

    $('accountBtn').addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
    $('settingsMenuBtn').addEventListener('click', openSettings);
    $('menuLoginBtn').addEventListener('click', () => { closeMenu(); Auth.openEntryGate(); });

    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsOverlay').addEventListener('click', e => {
      if (e.target === $('settingsOverlay')) closeSettings();
    });

    document.addEventListener('click', e => {
      if (isMenuOpen() && !e.target.closest('.sidebar-account')) closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('settingsOverlay').classList.contains('hidden')) closeSettings();
      else if (isMenuOpen()) closeMenu();
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', AccountUI.init);
