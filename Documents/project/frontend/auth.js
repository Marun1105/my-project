// auth.js — регистрация, вход, потвърждение на имейл, изход. Пази сесията в local/sessionStorage.
const Auth = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const TOKEN_KEY = 'climby-token';
  const USER_KEY = 'climby-user';
  const GUEST_KEY = 'climby-guest-skip';

  // "Remember me" checked -> localStorage (survives browser restarts).
  // Unchecked -> sessionStorage (cleared when the browser/tab closes).
  function getToken() { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); }

  function getUser() {
    const raw = localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY);
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  function isLoggedIn() { return !!getToken(); }

  function _setSession(token, user, remember) {
    const store = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    other.removeItem(TOKEN_KEY);
    other.removeItem(USER_KEY);
    store.setItem(TOKEN_KEY, token);
    store.setItem(USER_KEY, JSON.stringify(user));
    window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: true, user } }));
  }

  // showGate: true for an explicit "Log out" click (bring back the entry gate);
  // false for a silent session-expiry logout (401), which shouldn't interrupt whatever else is on screen.
  function logout(showGate) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    if (showGate) localStorage.removeItem(GUEST_KEY);
    window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: false, showGate: !!showGate } }));
    if (showGate) showEntryGate();
  }

  // ---------- entry gate (full-screen login/register shown before the app) ----------

  function showEntryGate() { $('entryGate').classList.remove('hidden'); }

  function hideEntryGate() {
    const wasOpen = !$('entryGate').classList.contains('hidden');
    $('entryGate').classList.add('hidden');
    // въведението чака бариерата да се махне, за да не се застъпват двата слоя
    if (wasOpen) window.dispatchEvent(new CustomEvent('climby:entry-gate-closed'));
  }

  function updateEntryGateVisibility() {
    if (isLoggedIn() || localStorage.getItem(GUEST_KEY) === '1') hideEntryGate();
    else showEntryGate();
  }

  function skipEntryGate() {
    localStorage.setItem(GUEST_KEY, '1');
    hideEntryGate();
  }

  async function _post(path, body) {
    let res;
    try {
      res = await Net.fetch(BACKEND + path, {
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

  async function register(displayName, email, password, role, username, phone, heardFrom) {
    // Празните полета се пращат като null, а не като "" — сървърът приема липса,
    // но празен низ би минал за избрано име и би се блъснал в уникалността.
    return _post('/auth/register', {
      display_name: displayName, email, password, role,
      username: username || null,
      phone: phone || null,
      heard_from: heardFrom || null,
    });
  }

  function getRole() {
    const user = getUser();
    return (user && user.role) || 'student';
  }

  async function verifyEmail(email, code) {
    const data = await _post('/auth/verify-email', { email, code });
    _setSession(data.token, data.user, true); // signing up implies wanting to stay logged in
    return data;
  }

  async function resendCode(email) {
    return _post('/auth/resend-code', { email });
  }

  async function login(email, password, remember) {
    const data = await _post('/auth/login', { email, password });
    _setSession(data.token, data.user, remember);
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

  // Заявката към сървъра може да отнеме близо минута, ако Render е заспал (виж net.js).
  // Без видим знак бутонът изглежда счупен: натискаш и не се случва нищо, натискаш пак
  // и тръгват няколко влизания едновременно. Затова бутонът се заключва и го казва.
  async function _withBusy(btn, fn) {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('auth.busy');
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // Enter в полетата трябва да прави същото като бутона — иначе изглежда, че нищо не става.
  function _submitOnEnter(formId, btnId) {
    $(formId).addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      $(btnId).click();
    });
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
    // Силата се показваше с цвят — а в черно-бяла тема --danger, --warn, --blue
    // и --accent са едно и също бяло. Тоест "слаба" се рисуваше най-ярко от
    // всички, точно обратното на смисъла. Затова степента вече е клас, а
    // плътността расте заедно с нея (виж .pw-strength-fill в style.css).
    let level, text;
    if (score <= 1) { level = 'is-weak'; text = t('auth.pwWeak'); }
    else if (score <= 2) { level = 'is-fair'; text = t('auth.pwFair'); }
    else if (score <= 3) { level = 'is-good'; text = t('auth.pwGood'); }
    else { level = 'is-strong'; text = t('auth.pwStrong'); }
    bar.className = 'pw-strength-fill ' + level;
    label.className = 'pw-strength-label ' + level;
    label.textContent = text;
  }

  async function handleRegister() {
    clearError();
    const name = $('registerName').value.trim();
    const email = $('registerEmail').value.trim();
    const password = $('registerPassword').value;
    const role = (document.querySelector('input[name="registerRole"]:checked') || {}).value || 'student';
    if (!name || !email || !password) {
      setError(t('auth.errFillAll'));
      return;
    }
    try {
      // Отговорът "откъде чу за нас" е даден още във въпросника при първото
      // отваряне — пътува с регистрацията, вместо да се пита пак.
      let heardFrom = null;
      try { heardFrom = localStorage.getItem('climby-quiz-heard'); } catch { /* без него също върви */ }
      await register(name, email, password, role,
                     $('registerUsername').value.trim(),
                     $('registerPhone').value.trim(),
                     heardFrom);
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
      await login(email, password, $('loginRemember').checked);
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
    logout(true);
  }

  function resetFormsOnLogout(e) {
    // Only touch the entry gate on a real login or an explicit "Log out" click —
    // a silent session-expiry logout (401) must not interrupt whatever's on screen.
    if (e.detail.loggedIn || e.detail.showGate) updateEntryGateVisibility();
    if (e.detail.loggedIn) return;
    ['loginForm', 'registerForm', 'verifyForm', 'forgotForm', 'resetForm'].forEach(id => {
      $(id).querySelectorAll('input[type="text"], input[type="email"], input[type="password"]').forEach(i => { i.value = ''; });
    });
    $('loginRemember').checked = false;
    $('registerPwStrength').classList.add('hidden');
    $('resetPwStrength').classList.add('hidden');
    pendingVerifyEmail = null;
    pendingResetEmail = null;
    showForm('login');
  }

  function init() {
    updateEntryGateVisibility();
    window.addEventListener('climby:auth-changed', resetFormsOnLogout);

    $('entryGateClose').addEventListener('click', skipEntryGate);
    $('checklistLoginBtn').addEventListener('click', showEntryGate);

    $('showRegister').addEventListener('click', e => { e.preventDefault(); showForm('register'); });
    $('showLogin').addEventListener('click', e => { e.preventDefault(); showForm('login'); });
    $('showForgot').addEventListener('click', e => { e.preventDefault(); showForm('forgot'); });
    $('showLoginFromForgot').addEventListener('click', e => { e.preventDefault(); showForm('login'); });
    $('resendCodeLink').addEventListener('click', e => { e.preventDefault(); handleResend(); });
    $('resendResetLink').addEventListener('click', e => { e.preventDefault(); handleResendReset(); });

    $('loginBtn').addEventListener('click', () => _withBusy($('loginBtn'), handleLogin));
    $('registerBtn').addEventListener('click', () => _withBusy($('registerBtn'), handleRegister));
    $('verifyBtn').addEventListener('click', () => _withBusy($('verifyBtn'), handleVerify));
    $('forgotBtn').addEventListener('click', () => _withBusy($('forgotBtn'), handleForgot));
    $('resetBtn').addEventListener('click', () => _withBusy($('resetBtn'), handleReset));
    $('logoutBtn').addEventListener('click', handleLogout);

    // Ролята, дадена във въпросника, идва отметната — питали сме веднъж.
    try {
      const hinted = localStorage.getItem('climby-quiz-role');
      const radio = hinted && document.querySelector(`input[name="registerRole"][value="${hinted}"]`);
      if (radio) radio.checked = true;
    } catch { /* без localStorage просто остава по подразбиране */ }

    _submitOnEnter('loginForm', 'loginBtn');
    _submitOnEnter('registerForm', 'registerBtn');
    _submitOnEnter('verifyForm', 'verifyBtn');
    _submitOnEnter('forgotForm', 'forgotBtn');
    _submitOnEnter('resetForm', 'resetBtn');

    $('registerPassword').addEventListener('input', () =>
      updatePwStrength('registerPassword', 'registerPwStrength', 'registerPwBar', 'registerPwLabel'));
    $('resetPassword').addEventListener('input', () =>
      updatePwStrength('resetPassword', 'resetPwStrength', 'resetPwBar', 'resetPwLabel'));
  }

  return { getToken, getUser, getRole, isLoggedIn, logout, init, openEntryGate: showEntryGate };
})();

document.addEventListener('DOMContentLoaded', Auth.init);
