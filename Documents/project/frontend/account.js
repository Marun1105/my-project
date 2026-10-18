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

  async function sendPwCode() {
    const user = Auth.getUser() || {};
    const msg = $('accountPwMsg');
    msg.classList.add('hidden');
    if (!user.email) { say(msg, t('account.errGeneric'), true); return; }
    const { ok, data } = await post('/auth/forgot-password', { channel: 'email', contact: user.email });
    if (!ok) { say(msg, (data && data.detail) || t('account.errGeneric'), true); return; }
    $('accountPwSent').textContent = t('account.pwSent', { email: user.email });
    $('accountPwForm').classList.remove('hidden');
    $('accountPwBtn').textContent = t('account.pwResend');
    $('accountPwCode').focus();
  }

  async function changePassword() {
    const user = Auth.getUser() || {};
    const msg = $('accountPwMsg');
    const code = $('accountPwCode').value.trim();
    const next = $('accountNewPw').value;
    if (!/^\d{6}$/.test(code)) { say(msg, t('account.pwBadCode'), true); return; }
    if (next.length < 8) { say(msg, t('account.pwTooShort'), true); return; }
    const reset = await post('/auth/reset-password', { channel: 'email', contact: user.email, code, new_password: next });
    if (!reset.ok) { say(msg, (reset.data && reset.data.detail) || t('account.errGeneric'), true); return; }
    // The change ended every session, this one too. Sign straight back in
    // with the new password so nobody is thrown out for doing the right thing.
    const login = await post('/auth/login', { identifier: user.email, password: next });
    if (login.ok && login.data.token) Auth.replaceSession(login.data.token, login.data.user);
    else { Auth.logout(true); return; }
    $('accountPwCode').value = ''; $('accountNewPw').value = '';
    $('accountPwForm').classList.add('hidden');
    $('accountPwBtn').textContent = t('account.changePw');
    say(msg, t('account.pwChanged'), false);
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
    // Gone. Sign out locally too, and let the app fall back to the gate.
    Auth.logout(true);
    const overlay = $('settingsOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function sync() {
    const on = !!(window.Auth && Auth.isLoggedIn());
    const rows = $('accountRows');
    if (rows) rows.classList.toggle('hidden', !on);
    if (!on && $('accountPwForm')) {
      $('accountPwForm').classList.add('hidden');
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
    sync();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init };
})();

window.Account = Account;
