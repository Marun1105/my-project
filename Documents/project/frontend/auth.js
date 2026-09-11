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
    // 'role' belongs here even though nothing calls showForm('role'): without it
    // the role screen is only ever closed by answering it, so dismissing the gate
    // and coming back leaves three role buttons stacked under the login form.
    ['login', 'register', 'verify', 'forgot', 'reset', 'role'].forEach(f => {
      const el = $(`${f}Form`);
      if (el) el.classList.toggle('hidden', f !== name);
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
    if ($('googleSignIn')) $('googleSignIn').addEventListener('click', startGoogle);
    revealGoogleIfAvailable();
    document.querySelectorAll('.role-choice').forEach(btn => {
      btn.addEventListener('click', () => chooseRole(btn.dataset.role));
    });
    if (window.CLIMBY_DESKTOP && window.CLIMBY_DESKTOP.onSignIn) {
      window.CLIMBY_DESKTOP.onSignIn(receiveDesktopSignIn);
    }
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

  // --- Google ---------------------------------------------------------------
  //
  // The browser leg has to happen in the REAL browser: Google refuses to run its
  // consent screen inside an embedded webview, so an in-app window would only
  // ever show an error.
  const NONCE_KEY = 'climby-oauth-nonce';

  // The button stays hidden until the server says the flow exists here. It is a
  // cheap request and it fails closed: no answer, no button, and the password
  // form — which always works — is untouched either way.
  function revealGoogleIfAvailable() {
    const block = $('googleBlock');
    if (!block) return;
    // Only the desktop shell can catch climby://auth. In a browser the tab would
    // reach the end of the flow and stop there, with the token undeliverable —
    // a button that looks like it works and does not.
    if (!(window.CLIMBY_DESKTOP && window.CLIMBY_DESKTOP.onSignIn)) return;
    fetch(BACKEND + '/auth/providers')
      .then(res => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(info => { if (info && info.google) block.classList.remove('hidden'); })
      .catch(() => { /* asleep or unreachable: leave it hidden */ });
  }

  function startGoogle() {
    // A value only this copy of Climby knows. It travels to the server and comes
    // back in the climby:// link, and a link that does not carry it is ignored
    // below — otherwise a link someone mails you signs your app into their
    // account, and everything you write afterwards lands in their profile.
    // crypto.getRandomValues, not Math.random: this is a security token, and
    // Math.random's next output can be derived from its previous ones. 128 bits,
    // hex — which also keeps it inside the character set the server accepts.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem(NONCE_KEY, nonce); } catch { /* private mode: the check below fails closed */ }
    window.open(BACKEND + '/auth/google/start?app=' + encodeURIComponent(nonce), '_blank');
  }

  // The desktop shell catches climby://auth and hands the payload here.
  function receiveDesktopSignIn(payload) {
    if (!payload || !payload.token) return;
    let expected = null;
    try { expected = sessionStorage.getItem(NONCE_KEY); } catch { /* nothing remembered */ }
    if (!expected || payload.nonce !== expected) {
      // We never asked for this sign-in. Say nothing and change nothing.
      return;
    }
    try { sessionStorage.removeItem(NONCE_KEY); } catch { /* it was one-use anyway */ }

    fetch(BACKEND + '/auth/me', { headers: { Authorization: 'Bearer ' + payload.token } })
      .then(res => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(user => {
        _setSession(payload.token, user, true);
        if (payload.isNew) showRoleChoice();
        else hideEntryGate();
      })
      .catch(() => setError(window.t ? t('auth.googleFailed') : 'Google sign-in did not work.'));
  }

  function showRoleChoice() {
    ['loginForm', 'registerForm', 'verifyForm'].forEach(id => {
      if ($(id)) $(id).classList.add('hidden');
    });
    if ($('roleForm')) $('roleForm').classList.remove('hidden');
    // The gate has to be re-opened, not merely left alone. _setSession fires
    // climby:auth-changed, whose listener sees a signed-in user and closes the
    // gate — and #roleForm lives inside it. Without this line the question is
    // asked into a hidden overlay and every Google account silently stays a
    // student, which is the one thing this screen exists to prevent.
    showEntryGate();
  }

  function chooseRole(role) {
    // The answer is remembered locally whatever the server says: the person is
    // already signed in, and a failed request here must not trap them on this
    // screen. A wrong role is fixable in Settings; a dead end is not.
    fetch(BACKEND + '/auth/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ role }),
    }).finally(() => {
      // If the session ended while this was in flight (an expired token
      // elsewhere logs out silently), writing the cached user back would leave a
      // user record with no token — getUser() answering while isLoggedIn() says
      // no. Better to leave nothing behind; the server holds the real role.
      if (!getToken()) return;
      const user = getUser() || {};
      user.role = role;
      const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
      store.setItem(USER_KEY, JSON.stringify(user));
      if ($('roleForm')) $('roleForm').classList.add('hidden');
      hideEntryGate();
      window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: true, user } }));
    });
  }

  return { getToken, getUser, getRole, isLoggedIn, logout, init, openEntryGate: showEntryGate };
})();

// Модулите се пишат като `const X = (() => {...})()`, а `const` на най-горно ниво
// НЕ става свойство на window — попада в лексикалната среда на скрипта. Затова
// проверки от вида `window.Auth && ...` в други файлове мълчаливо виждаха
// "няма Auth" и се отказваха: фокус сесиите не се записваха на никого, а менюто
// не скриваше чуждите роли. Затова връзката се прави тук изрично.
window.Auth = Auth;

document.addEventListener('DOMContentLoaded', Auth.init);
