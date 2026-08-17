// focus.js — фокус камера: брои тихо колко време ученикът е на бюрото, докато учи.
// Разпознаването (има ли лице в кадъра) става изцяло в браузъра с face-api.js — снимка никога не се качва
// или пази никъде, само броячи в паметта за текущата сесия. Не изисква акаунт.
const Focus = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
  const SAMPLE_MS = 600; // достатъчно често за да усеща рамката около лицето "на живо", tinyFaceDetector е лек
  const ENABLED_KEY = 'climby-focus-enabled';

  let stream = null;
  let modelReady = false;
  let sampleTimer = null;
  let sessionStart = null;
  let focusedTicks = 0;
  let awayTicks = 0;

  function isEnabled() { return localStorage.getItem(ENABLED_KEY) === '1'; }

  function setEnabled(v) {
    localStorage.setItem(ENABLED_KEY, v ? '1' : '0');
    if (!v) stopSession(true);
    updateToggleUI();
  }

  function updateToggleUI() {
    const enabled = isEnabled();
    $('focusEnableToggle').checked = enabled;
    $('focusToggleLabel').textContent = enabled ? t('focus.onLabel') : t('focus.offLabel');
    $('focusOff').classList.toggle('hidden', enabled);
    if (enabled) {
      showStage('Idle');
    } else {
      ['Idle', 'Loading', 'Running'].forEach(s => $(`focus${s}`).classList.add('hidden'));
      $('focusSummary').classList.add('hidden');
    }
  }

  function showStage(name) {
    ['Idle', 'Loading', 'Running'].forEach(s => $(`focus${s}`).classList.toggle('hidden', s !== name));
    $('focusSummary').classList.add('hidden');
    clearError();
    if (name === 'Idle') renderStreak();
  }

  // ---------- история и серия от дни (само за влезли, статистиката е по избор) ----------

  function dateKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function computeStreak(sessions) {
    const days = new Set(sessions.map(s => dateKey(s.created_at)));
    const cursor = new Date();
    if (!days.has(dateKey(cursor.toISOString()))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(dateKey(cursor.toISOString()))) return 0;
    }
    let streak = 0;
    while (days.has(dateKey(cursor.toISOString()))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  async function renderStreak() {
    const el = $('focusStreak');
    if (!el) return;
    if (!window.Auth || !Auth.isLoggedIn()) { el.classList.add('hidden'); return; }
    try {
      const res = await fetch(BACKEND + '/focus', {
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (!res.ok) throw new Error('bad status');
      const sessions = await res.json();
      if (!sessions.length) { el.classList.add('hidden'); return; }
      const streak = computeStreak(sessions);
      el.textContent = streak > 0
        ? t('focus.streak', { n: streak, days: streak === 1 ? t('history.dayOne') : t('history.dayMany') })
        : t('focus.sessionsLogged', { n: sessions.length });
      el.classList.remove('hidden');
    } catch {
      el.classList.add('hidden');
    }
  }

  async function saveSession(totalMs) {
    if (!window.Auth || !Auth.isLoggedIn()) return;
    const durationSeconds = Math.round(totalMs / 1000);
    if (durationSeconds < 60) return; // твърде кратка сесия, за да си струва да се пази
    const totalTicks = focusedTicks + awayTicks;
    const focusPct = totalTicks ? Math.round((focusedTicks / totalTicks) * 100) : null;
    try {
      await fetch(BACKEND + '/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.getToken()}` },
        body: JSON.stringify({ duration_seconds: durationSeconds, focus_pct: focusPct }),
      });
    } catch {
      // статистиката не е критична — сесията вече приключи за ученика, независимо дали се е записала
    }
  }

  function setError(msg) {
    const el = $('focusError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearError() { $('focusError').classList.add('hidden'); }

  async function ensureModel() {
    if (modelReady) return;
    if (typeof faceapi === 'undefined') {
      throw new Error(t('focus.errModelLoading'));
    }
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    modelReady = true;
  }

  async function startSession() {
    clearError();
    showStage('Loading');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 240, height: 180 }, audio: false });
    } catch {
      setError(t('focus.errNoCamera'));
      showStage('Idle');
      return;
    }

    try {
      await ensureModel();
    } catch (err) {
      setError(err.message || t('focus.errModel'));
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      showStage('Idle');
      return;
    }

    $('focusVideo').srcObject = stream;
    sessionStart = Date.now();
    focusedTicks = 0;
    awayTicks = 0;
    drawOverlay(null);
    showStage('Running');
    $('focusBadge').classList.remove('hidden');
    sampleTimer = setInterval(sampleFrame, SAMPLE_MS);
  }

  // рисува рамка около засеченото лице, за да се вижда, че камерата наистина разпознава —
  // изцяло козметично, координатите идват от face-api и никога не напускат браузъра
  function sizeOverlay(video, canvas) {
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  }

  function drawOverlay(box) {
    const canvas = $('focusOverlay');
    if (!canvas || !canvas.width) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!box) return;

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2ec25f';
    const { x, y, width, height } = box;
    const r = Math.min(18, width * 0.18, height * 0.18);
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(3, canvas.width * 0.012);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.stroke();
  }

  async function sampleFrame() {
    const video = $('focusVideo');
    const canvas = $('focusOverlay');
    if (!video || !video.videoWidth || !canvas) return;
    sizeOverlay(video, canvas);
    try {
      const result = await faceapi.detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 })
      );
      if (result) { focusedTicks++; drawOverlay(result.box); }
      else { awayTicks++; drawOverlay(null); }
    } catch {
      // тих пропуск на този сампъл — една неуспешна проверка не бива да спира сесията
    }
  }

  function stopSession(silent) {
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    $('focusBadge').classList.add('hidden');
    drawOverlay(null);

    if (!sessionStart) {
      if (!silent) showStage('Idle');
      return;
    }
    const totalMs = Date.now() - sessionStart;
    sessionStart = null;
    if (silent) {
      showStage('Idle');
    } else {
      saveSession(totalMs);
      showSummary(totalMs);
    }
  }

  function formatMinutes(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return t('focus.underMinute');
    return `${mins} ${mins === 1 ? t('focus.minuteOne') : t('focus.minuteMany')}`;
  }

  function showSummary(totalMs) {
    ['Idle', 'Loading', 'Running'].forEach(s => $(`focus${s}`).classList.add('hidden'));
    const totalTicks = focusedTicks + awayTicks;
    const pct = totalTicks ? Math.round((focusedTicks / totalTicks) * 100) : null;
    const time = formatMinutes(totalMs);

    let message;
    if (totalTicks === 0) {
      message = t('focus.summaryShort', { time });
    } else if (pct >= 80) {
      message = t('focus.summaryGreat', { time, pct });
    } else if (pct >= 50) {
      message = t('focus.summaryGood', { time, pct });
    } else {
      message = t('focus.summaryLow', { time, pct });
    }

    $('focusSummaryCard').innerHTML = `<p>${message}</p>`;
    $('focusSummary').classList.remove('hidden');
  }

  function init() {
    $('focusEnableToggle').addEventListener('change', e => setEnabled(e.target.checked));
    $('focusStartBtn').addEventListener('click', startSession);
    $('focusStopBtn').addEventListener('click', () => stopSession(false));
    $('focusAgainBtn').addEventListener('click', () => showStage('Idle'));
    window.addEventListener('climby:lang-changed', updateToggleUI);
    updateToggleUI();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Focus.init);
