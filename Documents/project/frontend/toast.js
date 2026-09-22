// toast.js — a short line at the bottom of the screen, with an optional way back.
//
// Until now the app had two ways to say something went well or went wrong: a
// full-screen state, or nothing. A one-line message that fades is what every
// app uses for "saved", "deleted", "no connection" — small enough not to
// interrupt, visible enough to be read. The optional action is what makes
// deleting safe without a confirmation box standing in the way.
const Toast = (() => {
  let host = null;

  function stage() {
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      // announced once, politely: a screen reader gets the same message
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  // show('Task deleted', { action: { label: 'Undo', onClick } })
  function show(message, opts = {}) {
    const { action = null, timeout = action ? 8000 : 4000, tone = '' } = opts;
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ' toast-' + tone : '');

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.appendChild(text);

    const close = () => {
      el.classList.add('is-going');
      setTimeout(() => el.remove(), 200);
    };

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { close(); action.onClick(); });
      el.appendChild(btn);
    }

    stage().appendChild(el);
    // one frame later, so the transition has a starting point to move from
    requestAnimationFrame(() => el.classList.add('is-in'));
    let timer = setTimeout(close, timeout);
    // reading it should not cost you the chance to press it
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 3000); });
    return { close };
  }

  return { show };
})();

window.Toast = Toast;
