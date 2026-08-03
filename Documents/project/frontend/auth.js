// auth.js — регистрация, вход, потвърждение на имейл, изход. Пази сесията в localStorage.
const Auth = (() => {
  const $ = id => document.getElementById(id);
  // Адресът на бекенда. Локално смени с http://127.0.0.1:8000
  const BACKEND = 'https://my-project-0gyk.onrender.com';
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
      throw new Error('Не успях да се свържа със сървъра. Провери интернета си и опитай пак.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(_errorMessage(data.detail));
    return data;
  }

  function _errorMessage(detail) {
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) return detail.map(d => d.msg).join(' ');
    return 'Нещо се обърка. Опитай пак.';
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

  // ---------- UI ----------

  let pendingVerifyEmail = null;

  function showForm(name) {
    ['login', 'register', 'verify'].forEach(f => {
      $(`${f}Form`).classList.toggle('hidden', f !== name);
    });
    clearError();
  }

  function setError(msg) {
    const el = $('authError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearError() {
    $('authError').classList.add('hidden');
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
      setError('Попълни всички полета, за да продължиш.');
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
      setError('Попълни имейл и парола.');
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
      setError('Въведи кода от имейла си.');
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
      setError('Изпратихме нов код — провери пощата си.');
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    logout();
  }

  function resetFormsOnLogout(e) {
    if (e.detail.loggedIn) return;
    ['loginForm', 'registerForm', 'verifyForm'].forEach(id => {
      $(id).querySelectorAll('input').forEach(i => { i.value = ''; });
    });
    pendingVerifyEmail = null;
    showForm('login');
  }

  function init() {
    updateHeaderBadge();
    window.addEventListener('climby:auth-changed', updateHeaderBadge);
    window.addEventListener('climby:auth-changed', resetFormsOnLogout);

    $('showRegister').addEventListener('click', e => { e.preventDefault(); showForm('register'); });
    $('showLogin').addEventListener('click', e => { e.preventDefault(); showForm('login'); });
    $('resendCodeLink').addEventListener('click', e => { e.preventDefault(); handleResend(); });

    $('loginBtn').addEventListener('click', handleLogin);
    $('registerBtn').addEventListener('click', handleRegister);
    $('verifyBtn').addEventListener('click', handleVerify);
    $('logoutBtn').addEventListener('click', handleLogout);
  }

  return { getToken, getUser, isLoggedIn, logout, init };
})();

document.addEventListener('DOMContentLoaded', Auth.init);
