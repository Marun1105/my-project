// offline.js — say so when there is no connection.
//
// Without this, dropped Wi-Fi looked exactly like a broken app: the button went
// grey, net.js spent a minute knocking on a server that could not be reached,
// and the student was told "check your internet" only at the end of it. The
// browser already knows. A bar across the top says it immediately, and takes
// itself away when the connection comes back.
(() => {
  let bar = null;

  function draw(online) {
    if (online) {
      if (bar) bar.classList.add('hidden');
      document.body.classList.remove('is-offline');
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'offline-bar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.textContent = window.t
      ? t(window.matchMedia('(max-width: 860px)').matches ? 'net.offlineShort' : 'net.offline')
      : 'No internet connection.';
    bar.classList.remove('hidden');
    document.body.classList.add('is-offline');
  }

  let wasOffline = false;

  function sync() {
    const on = navigator.onLine;
    if (!on) wasOffline = true;
    draw(on);
  }

  window.addEventListener('online', () => {
    const announce = wasOffline;
    wasOffline = false;
    sync();
    if (announce && window.Toast) Toast.show(window.t ? t('net.backOnline') : 'Back online', { tone: 'good' });
  });
  window.addEventListener('offline', sync);
  document.addEventListener('DOMContentLoaded', sync);
  // the language can change while the bar is already up
  window.addEventListener('climby:lang-changed', sync);
})();
