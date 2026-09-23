// password-eye.js — a show/hide toggle on every password field.
//
// Every sign-in form has one. Without it a mistyped password is invisible
// until the server says no, and a long one is typed blind. Added by script so
// the fields keep their markup; the button is a real button, labelled, and
// keeps the field's tab order (it comes after it).
(() => {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.3 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function attach(input) {
    if (input.dataset.eye) return;
    input.dataset.eye = '1';
    let wrap = input.parentElement;
    if (!wrap) return;
    const ownWrapper = wrap.classList.contains('field')
      && wrap.querySelectorAll('input, textarea, select').length === 1;
    if (!ownWrapper) {
      const box = document.createElement('span');
      box.className = 'eye-wrap';
      input.insertAdjacentElement('beforebegin', box);
      box.appendChild(input);
      wrap = box;
    }
    wrap.classList.add('has-eye');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-eye';
    btn.setAttribute('aria-label', window.t ? t('auth.showPassword') : 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = EYE;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', window.t ? t(show ? 'auth.hidePassword' : 'auth.showPassword') : (show ? 'Hide password' : 'Show password'));
      input.focus();
    });
    input.insertAdjacentElement('afterend', btn);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[type="password"]').forEach(attach);
  });
})();
