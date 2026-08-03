// focus.js — фокус камера: брои тихо колко време ученикът е на бюрото, докато учи.
// Разпознаването (има ли лице в кадъра) става изцяло в браузъра с face-api.js — снимка никога не се качва
// или пази никъде, само броячи в паметта за текущата сесия. Не изисква акаунт.
const Focus = (() => {
  const $ = id => document.getElementById(id);
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
  const SAMPLE_MS = 4000; // проверка на всеки 4 секунди — достатъчно често, не хаби батерията
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
    $('focusToggleLabel').textContent = enabled ? 'Фокус камерата е включена' : 'Фокус камерата е изключена';
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
      throw new Error('Разпознаването още се зарежда — изчакай малко и опитай пак.');
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
      setError('Нямам достъп до камерата — провери разрешенията на браузъра и опитай пак.');
      showStage('Idle');
      return;
    }

    try {
      await ensureModel();
    } catch (err) {
      setError(err.message || 'Не успях да заредя разпознаването. Провери интернета си и опитай пак.');
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      showStage('Idle');
      return;
    }

    $('focusVideo').srcObject = stream;
    sessionStart = Date.now();
    focusedTicks = 0;
    awayTicks = 0;
    showStage('Running');
    $('focusBadge').classList.remove('hidden');
    sampleTimer = setInterval(sampleFrame, SAMPLE_MS);
  }

  async function sampleFrame() {
    const video = $('focusVideo');
    if (!video || !video.videoWidth) return;
    try {
      const result = await faceapi.detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 })
      );
      if (result) focusedTicks++; else awayTicks++;
    } catch {
      // тих пропуск на този сампъл — една неуспешна проверка не бива да спира сесията
    }
  }

  function stopSession(silent) {
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    $('focusBadge').classList.add('hidden');

    if (!sessionStart) {
      if (!silent) showStage('Idle');
      return;
    }
    const totalMs = Date.now() - sessionStart;
    sessionStart = null;
    if (silent) {
      showStage('Idle');
    } else {
      showSummary(totalMs);
    }
  }

  function formatMinutes(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'под минута';
    return `${mins} ${mins === 1 ? 'минута' : 'минути'}`;
  }

  function showSummary(totalMs) {
    ['Idle', 'Loading', 'Running'].forEach(s => $(`focus${s}`).classList.add('hidden'));
    const totalTicks = focusedTicks + awayTicks;
    const pct = totalTicks ? Math.round((focusedTicks / totalTicks) * 100) : null;
    const time = formatMinutes(totalMs);

    let message;
    if (totalTicks === 0) {
      message = `Работи ${time}. Сесията беше твърде кратка, за да преброя точно — но всяко започване е крачка напред!`;
    } else if (pct >= 80) {
      message = `Страхотна сесия! Работи ${time} и беше на бюрото си през по-голямата част от времето (~${pct}%). Продължавай все така.`;
    } else if (pct >= 50) {
      message = `Работи ${time}, от които около ${pct}% на бюрото. Добро начало — следващия път пробвай по-кратки, съсредоточени части.`;
    } else {
      message = `Работи ${time}. Изглежда е било трудно да останеш на бюрото днес (~${pct}% от времето) — това се случва на всеки. Следващия път пробвай кратка сесия от 10-15 минути, без да се притесняваш.`;
    }

    $('focusSummaryCard').innerHTML = `<p>${message}</p>`;
    $('focusSummary').classList.remove('hidden');
  }

  function init() {
    $('focusEnableToggle').addEventListener('change', e => setEnabled(e.target.checked));
    $('focusStartBtn').addEventListener('click', startSession);
    $('focusStopBtn').addEventListener('click', () => stopSession(false));
    $('focusAgainBtn').addEventListener('click', () => showStage('Idle'));
    updateToggleUI();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Focus.init);
