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
    renderDevices();
  }

  // Свързаните телефони. Списъкът се презарежда при всяко отваряне, а не се пази:
  // телефон може да е бил откачен от друго устройство, а тук се идва точно
  // когато нещо трябва да се откачи.
  function renderDevices() {
    const box = $('settingsDevices');
    if (!box) return;
    box.textContent = '';

    if (!window.Auth || !Auth.isLoggedIn()) {
      $('settingsDevicesRow').classList.add('hidden');
      return;
    }
    $('settingsDevicesRow').classList.remove('hidden');

    Promise.resolve(window.Phone ? Phone.refreshDevices() : null).then(() => {
      const devices = window.Phone ? Phone.listPaired() : [];
      box.textContent = '';
      if (!devices.length) {
        box.appendChild(_note(t('settings.devicesEmpty')));
        return;
      }
      devices.forEach(device => box.appendChild(_deviceRow(device)));
      // Какво може свързаният телефон се казва веднъж, под списъка — там, където
      // човекът тъкмо е видял имената. Като празен екран не носи нищо.
      box.appendChild(_note(t('settings.devicesHint')));
    });
  }

  function _note(text) {
    const el = document.createElement('p');
    el.className = 'settings-note';
    el.textContent = text;
    return el;
  }

  function _deviceRow(device) {
    const row = document.createElement('div');
    row.className = 'device-row';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name;
    left.appendChild(name);

    if (device.last_seen_at) {
      const meta = document.createElement('div');
      meta.className = 'device-meta';
      meta.textContent = new Date(device.last_seen_at).toLocaleDateString();
      left.appendChild(meta);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-link';
    btn.textContent = t('settings.forget');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      Phone.forget(device.id).then(renderDevices).catch(() => { btn.disabled = false; });
    });

    row.appendChild(left);
    row.appendChild(btn);
    return row;
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
    window.addEventListener('climby:auth-changed', renderDevices);
    // Смяната на езика става В ТОЗИ прозорец. Без този ред единственият текст,
    // който остава на стария език, е точно този под превключвателя.
    window.addEventListener('climby:lang-changed', renderDevices);

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
