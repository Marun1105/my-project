// auth.js — регистрация, вход, потвърждение на имейл, изход. Пази сесията в localStorage.
const Auth = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const TOKEN_KEY = 'climby-token';
  const USER_KEY = 'climby-user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); }
    catch { return null; }
  }

  function isLoggedIn() { return !!getToken(); }

  function _setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: true, user } }));
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: false } }));
  }

  async function _post(path, body) {
    let res;
    try {
      res = await fetch(BACKEND + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(t('auth.errOffline'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(_errorMessage(data.detail));
    return data;
  }

  function _errorMessage(detail) {
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) return detail.map(d => d.msg).join(' ');
    return t('auth.errGeneric');
  }

  async function register(displayName, email, password) {
    return _post('/auth/register', { display_name: displayName, email, password });
  }

  async function verifyEmail(email, code) {
    const data = await _post('/auth/verify-email', { email, code });
    _setSession(data.token, data.user);
    return data;
  }

  async function resendCode(email) {
    return _post('/auth/resend-code', { email });
  }

  async function login(email, password) {
    const data = await _post('/auth/login', { email, password });
    _setSession(data.token, data.user);
    return data;
  }

  async function forgotPassword(email) {
    return _post('/auth/forgot-password', { channel: 'email', contact: email });
  }

  async function resetPassword(email, code, newPassword) {
    return _post('/auth/reset-password', { channel: 'email', contact: email, code, new_password: newPassword });
  }

  // ---------- UI ----------

  let pendingVerifyEmail = null;
  let pendingResetEmail = null;

  function showForm(name) {
    ['login', 'register', 'verify', 'forgot', 'reset'].forEach(f => {
      $(`${f}Form`).classList.toggle('hidden', f !== name);
    });
    $('authIntro').classList.toggle('hidden', name !== 'login' && name !== 'register');
    clearError();
  }

  // kind 'error' (red, something went wrong) vs 'success' (green, informational — code sent, password changed)
  function setError(msg, kind) {
    const el = $('authError');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.toggle('is-error', kind !== 'success');
    el.classList.toggle('is-success', kind === 'success');
  }

  function setNotice(msg) {
    setError(msg, 'success');
  }

  function clearError() {
    $('authError').classList.add('hidden');
  }

  // ---------- password strength meter (register + reset) ----------

  function pwScore(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    return score;
  }

  function updatePwStrength(inputId, wrapId, barId, labelId) {
    const pw = $(inputId).value;
    const wrap = $(wrapId);
    if (!pw) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const score = pwScore(pw);
    const bar = $(barId);
    const label = $(labelId);
    const pct = Math.min(100, (score / 5) * 100);
    bar.style.width = pct + '%';
    let color, text;
    if (score <= 1) { color = 'var(--danger)'; text = t('auth.pwWeak'); }
    else if (score <= 2) { color = 'var(--warn)'; text = t('auth.pwFair'); }
    else if (score <= 3) { color = 'var(--blue)'; text = t('auth.pwGood'); }
    else { color = 'var(--accent)'; text = t('auth.pwStrong'); }
    bar.style.background = color;
    label.style.color = color;
    label.textContent = text;
  }

  function updateHeaderBadge() {
    const badge = $('userBadge');
    const user = getUser();
    if (user) {
      $('userName').textContent = user.display_name;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  async function handleRegister() {
    clearError();
    const name = $('registerName').value.trim();
    const email = $('registerEmail').value.trim();
    const password = $('registerPassword').value;
    if (!name || !email || !password) {
      setError(t('auth.errFillAll'));
      return;
    }
    try {
      await register(name, email, password);
      pendingVerifyEmail = email;
      showForm('verify');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleLogin() {
    clearError();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) {
      setError(t('auth.errFillLogin'));
      return;
    }
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleVerify() {
    clearError();
    const code = $('verifyCode').value.trim();
    if (!code || !pendingVerifyEmail) {
      setError(t('auth.errEnterCode'));
      return;
    }
    try {
      await verifyEmail(pendingVerifyEmail, code);
      pendingVerifyEmail = null;
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResend() {
    if (!pendingVerifyEmail) return;
    clearError();
    try {
      await resendCode(pendingVerifyEmail);
      setNotice(t('auth.newCodeSent'));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleForgot() {
    clearError();
    const email = $('forgotEmail').value.trim();
    if (!email) {
      setError(t('auth.errEnterEmail'));
      return;
    }
    try {
      await forgotPassword(email);
      pendingResetEmail = email;
      showForm('reset');
      setNotice(t('auth.resetCodeSentMaybe'));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReset() {
    clearError();
    const code = $('resetCode').value.trim();
    const password = $('resetPassword').value;
    if (!pendingResetEmail || !code || !password) {
      setError(t('auth.errFillReset'));
      return;
    }
    try {
      await resetPassword(pendingResetEmail, code, password);
      pendingResetEmail = null;
      $('loginEmail').value = '';
      showForm('login');
      setNotice(t('auth.passwordChanged'));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResendReset() {
    if (!pendingResetEmail) return;
    clearError();
    try {
      await forgotPassword(pendingResetEmail);
      setError(t('auth.resetCodeSent'));
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    logout();
  }

  function resetFormsOnLogout(e) {
    if (e.detail.loggedIn) return;
    ['loginForm', 'registerForm', 'verifyForm', 'forgotForm', 'resetForm'].forEach(id => {
      $(id).querySelectorAll('input').forEach(i => { i.value = ''; });
    });
    $('registerPwStrength').classList.add('hidden');
    $('resetPwStrength').classList.add('hidden');
    pendingVerifyEmail = null;
    pendingResetEmail = null;
    showForm('login');
  }

  function init() {
    updateHeaderBadge();
    window.addEventListener('climby:auth-changed', updateHeaderBadge);
    window.addEventListener('climby:auth-changed', resetFormsOnLogout);

    $('showRegister').addEventListener('click', e => { e.preventDefault(); showForm('register'); });
    $('showLogin').addEventListener('click', e => { e.preventDefault(); showForm('login'); });
    $('showForgot').addEventListener('click', e => { e.preventDefault(); showForm('forgot'); });
    $('showLoginFromForgot').addEventListener('click', e => { e.preventDefault(); showForm('login'); });
    $('resendCodeLink').addEventListener('click', e => { e.preventDefault(); handleResend(); });
    $('resendResetLink').addEventListener('click', e => { e.preventDefault(); handleResendReset(); });

    $('loginBtn').addEventListener('click', handleLogin);
    $('registerBtn').addEventListener('click', handleRegister);
    $('verifyBtn').addEventListener('click', handleVerify);
    $('forgotBtn').addEventListener('click', handleForgot);
    $('resetBtn').addEventListener('click', handleReset);
    $('logoutBtn').addEventListener('click', handleLogout);

    $('registerPassword').addEventListener('input', () =>
      updatePwStrength('registerPassword', 'registerPwStrength', 'registerPwBar', 'registerPwLabel'));
    $('resetPassword').addEventListener('input', () =>
      updatePwStrength('resetPassword', 'resetPwStrength', 'resetPwBar', 'resetPwLabel'));
  }

  return { getToken, getUser, isLoggedIn, logout, init };
})();

document.addEventListener('DOMContentLoaded', Auth.init);
