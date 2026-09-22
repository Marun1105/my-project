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
  async function changePassword(e) {
    e.preventDefault();
    const msg = $('accountPwMsg');
    const current = $('accountCurrentPw').value;
    const next = $('accountNewPw').value;
    if (next.length < 8) { say(msg, t('account.pwTooShort'), true); return; }
    const res = await call('/account/password', { method: 'POST', body: JSON.stringify({ current_password: current || null, new_password: next }) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) { say(msg, (data && data.detail) || t('account.errGeneric'), true); return; }
    Auth.replaceSession(data.token, data.user);
    $('accountCurrentPw').value = ''; $('accountNewPw').value = '';
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
      alert(t('account.errGeneric'));
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
    if (!on && $('accountDeleteForm')) {
      $('accountDeleteForm').classList.add('hidden');
      $('accountDeleteBtn').classList.remove('hidden');
    }
  }

  function init() {
    if (!$('accountRows')) return;
    $('accountPasswordForm').addEventListener('submit', changePassword);
    $('accountExportBtn').addEventListener('click', exportData);
    $('accountDeleteBtn').addEventListener('click', revealDelete);
    $('accountDeleteForm').addEventListener('submit', deleteAccount);
    window.addEventListener('climby:auth-changed', sync);
    sync();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init };
})();

window.Account = Account;
