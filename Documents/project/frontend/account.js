// account.js — the account itself, from Settings: password, data, leaving.
//
// Three things a person is entitled to ask of an app that keeps their data.
// They lived nowhere until now; a parent asking "delete my child's account"
// could only be answered by hand. Now it is a button, with a confirmation,
// because it is total.
const Account = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  async function call(path, options = {}) {
    const res = await Net.fetch(BACKEND + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.getToken()}`, ...(options.headers || {}) },
    });
    return res;
  }

  function say(el, text, isError) {
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
    el.classList.remove('hidden');
  }

  // ---- password ----
  // No current-password form any more. The button emails a code (the same
  // one "Forgot password" sends), and only the code plus a new password
  // change it: a computer left signed in is not enough to take the account.
  async function post(path, body) {
    const res = await Net.fetch(BACKEND + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    return { ok: !!(res && res.ok), data };
  }

  // FastAPI answers a validation error with a list; show its words, not
  // "[object Object]".
  function detailText(data) {
    const d = data && data.detail;
    if (Array.isArray(d)) return d.map(x => x && x.msg).filter(Boolean).join(' ') || t('account.errGeneric');
    return typeof d === 'string' && d ? d : t('account.errGeneric');
  }

  let pwCodeSent = false;   // the button says "send a new code" once one is out

  function paintPw() {
    const btn = $('accountPwBtn');
    if (!btn) return;
    btn.textContent = t(pwCodeSent ? 'account.pwResend' : 'account.changePw');
    const user = (window.Auth && Auth.getUser()) || {};
    if (pwCodeSent) $('accountPwSent').textContent = t('account.pwSent', { email: user.email || '' });
  }

  function resetPw() {
    pwCodeSent = false;
    $('accountPwCode').value = '';
    $('accountNewPw').value = '';
    $('accountPwForm').classList.add('hidden');
    paintPw();
  }

  async function sendPwCode() {
    const user = Auth.getUser() || {};
    const msg = $('accountPwMsg');
    msg.classList.add('hidden');
    if (!user.email) { say(msg, t('account.errGeneric'), true); return; }
    const { ok, data } = await post('/auth/forgot-password', { channel: 'email', contact: user.email });
    if (!ok) { say(msg, detailText(data), true); return; }
    pwCodeSent = true;
    paintPw();
    $('accountPwForm').classList.remove('hidden');
    $('accountPwCode').focus();
  }

  async function changePassword() {
    const user = Auth.getUser() || {};
    const msg = $('accountPwMsg');
    const code = $('accountPwCode').value.trim();
    const next = $('accountNewPw').value;
    if (!/^\d{6}$/.test(code)) { say(msg, t('account.pwBadCode'), true); return; }
    if (next.length < 8) { say(msg, t('account.pwTooShort'), true); return; }
    // Decided before the reset: between it and the new sign-in the old token is
    // dead, and any request that meets a 401 then clears the stored session.
    const remember = (() => { try { return !!localStorage.getItem('climby-token'); } catch { return false; } })();
    const reset = await post('/auth/reset-password', { channel: 'email', contact: user.email, code, new_password: next });
    if (!reset.ok) { say(msg, detailText(reset.data), true); return; }
    // The change ended every session, this one too. Sign straight back in
    // with the new password so nobody is thrown out for doing the right thing.
    const login = await post('/auth/login', { identifier: user.email, password: next });
    resetPw();
    if (login.ok && login.data.token) {
      Auth.replaceSession(login.data.token, login.data.user, remember);
      say(msg, t('account.pwChanged'), false);
      return;
    }
    // The password did change; only the sign-in after it failed (a rate limit
    // on a school network, a dropped connection). Say so before the gate.
    if (window.Toast) Toast.show(t('account.pwChangedSignIn'));
    Auth.logout(true);
  }

  // ---- export ----
  async function exportData() {
    const btn = $('accountExportBtn');
    btn.disabled = true;
    try {
      const res = await call('/account/export');
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name ? name[1] : 'climby-export.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch {
      if (window.Toast) Toast.show(t('account.errGeneric'));
    } finally {
      btn.disabled = false;
    }
  }

  // ---- delete ----
  function revealDelete() {
    const user = Auth.getUser() || {};
    const hasPw = user.has_password !== false;   // older stored users have no flag: assume a password
    $('accountDeletePw').classList.toggle('hidden', !hasPw);
    $('accountDeleteWord').classList.toggle('hidden', hasPw);
    $('accountDeleteForm').classList.remove('hidden');
    $('accountDeleteBtn').classList.add('hidden');
    (hasPw ? $('accountDeletePw') : $('accountDeleteWord')).focus();
  }

  async function deleteAccount(e) {
    e.preventDefault();
    const msg = $('accountDeleteMsg');
    const body = { password: $('accountDeletePw').value || null, confirm: $('accountDeleteWord').value || null };
    const res = await call('/account', { method: 'DELETE', body: JSON.stringify(body) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) { say(msg, (data && data.detail) || t('account.errGeneric'), true); return; }
    // Gone — and so is what this device kept for it: the photo, the memory
    // switch and note, the chats. The screen said "for good".
    const id = (Auth.getUser() || {}).id;
    if (id) {
      try {
        ['climby-photo:', 'climby-memory-v1:', 'climby-chats-v1:'].forEach(prefix =>
          localStorage.removeItem(prefix + encodeURIComponent(String(id))));
        ['climby-photo:', 'climby-chats-v1:'].forEach(prefix => localStorage.removeItem(prefix + String(id)));
      } catch { /* nothing kept, nothing to remove */ }
    }
    // Sign out locally too, and let the app fall back to the gate.
    Auth.logout(true);
    const overlay = $('settingsOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function sync() {
    const on = !!(window.Auth && Auth.isLoggedIn());
    const rows = $('accountRows');
    if (rows) rows.classList.toggle('hidden', !on);
    if (!on && $('accountPwForm')) {
      resetPw();
      $('accountPwMsg').classList.add('hidden');
    }
    if (!on && $('accountDeleteForm')) {
      $('accountDeleteForm').classList.add('hidden');
      $('accountDeleteBtn').classList.remove('hidden');
    }
  }

  function init() {
    if (!$('accountRows')) return;
    // Two presses sent two changes; the second one failed on the old password
    // the first had just replaced, and said so in red.
    $('accountPwBtn').addEventListener('click', () => Net.guardClick($('accountPwBtn'), sendPwCode));
    $('accountPwForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, changePassword);
    });
    $('accountExportBtn').addEventListener('click', exportData);
    $('accountDeleteBtn').addEventListener('click', revealDelete);
    $('accountDeleteForm').addEventListener('submit', e => {
      e.preventDefault();
      Net.guardSubmit(e.currentTarget, () => deleteAccount(e));
    });
    window.addEventListener('climby:auth-changed', sync);
    // the language changes inside this very window; the button must follow
    window.addEventListener('climby:lang-changed', paintPw);
    sync();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init };
})();

window.Account = Account;
