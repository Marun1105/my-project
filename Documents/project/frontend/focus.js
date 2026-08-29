// focus.js — фокус камера: брои тихо колко време ученикът е на бюрото, докато учи.
// Разпознаването (има ли лице в кадъра) става изцяло в браузъра с face-api.js — снимка никога не се качва
// или пази никъде, само броячи в паметта за текущата сесия. Не изисква акаунт.
const Focus = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
  const ENABLED_KEY = 'climby-focus-enabled';

  let stream = null;
  let modelReady = false;
  let sessionStart = null;
  let focusedMs = 0;   // време, а не кадри
  let awayMs = 0;

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
      const res = await Net.fetch(BACKEND + '/focus', {
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
    const trackedMs = focusedMs + awayMs;
    const focusPct = trackedMs ? Math.round((focusedMs / trackedMs) * 100) : null;
    try {
      await Net.fetch(BACKEND + '/focus', {
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
    focusedMs = 0;
    awayMs = 0;
    showStage('Running');
    $('focusBadge').classList.remove('hidden');
    startTracking();
  }

  // ---------- разпознаване и рисуване ----------
  //
  // Наивният вариант беше "има ли лице в кадъра" на всеки 600 ms. По него човек,
  // който гледа през прозореца, се брои за фокусиран, а всяко мигване — за
  // отсъствие. Затова тук се смятат няколко сигнала и се решава по тях заедно.
  //
  // Срещу трептенето стоят четири неща:
  //   • разпознаването и рисуването са разделени — моделът се пуска шест пъти в
  //     секундата, а се рисува на всеки кадър, като точките догонват находката;
  //   • всеки сигнал минава през плъзгаща средна, вместо да се ползва суров;
  //   • състоянието има два прага, не един: влиза се във "фокусиран" при 0.62 и
  //     се излиза чак под 0.38, така че на границата не мига;
  //   • мигането и краткото навеждане към тетрадката имат гратис.
  const DETECT_MS = 160;          // колко често пускаме модела
  const SMOOTH = 0.35;            // плъзгаща средна на сигналите
  const POINT_SMOOTH = 0.45;      // догонване на точките при рисуване
  const EAR_CLOSED = 0.19;        // под това окото се води затворено
  const BLINK_GRACE_MS = 500;     // затворени очи дотук още не са "не гледа"
  const LOST_GRACE_MS = 1600;     // липсващо лице дотук още не е "излязъл"
  const ENTER_FOCUS = 0.62;
  const LEAVE_FOCUS = 0.38;       // нарочно по-нисък от горния
  const MIN_FACE_FRAC = 0.10;     // по-малко лице от това = твърде далеч

  let rafId = null;
  let lastDetect = 0;
  let landmarks = null;           // последните намерени точки, в координати на видеото
  let drawPoints = null;          // изгладените, които реално рисуваме
  let faceBox = null, drawBox = null;
  let lastSeen = 0;
  let eyesClosedSince = 0;
  let scores = { eyes: 0, gaze: 0, near: 0 };
  let focusScore = 0;
  let isFocused = false;
  let lastTickAt = 0;

  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Отношението височина/ширина на окото: отворено е около 0.30, затворено пада
  // към 0.10. Затова мигането личи като рязък спад, а не като изчезнало лице.
  function eyeAspect(e) {
    const wide = dist(e[0], e[3]) || 1;
    return (dist(e[1], e[5]) + dist(e[2], e[4])) / (2 * wide);
  }

  // Накъде гледа главата. Носът стои по средата между очите, когато гледаш
  // право напред; извърнеш ли се, се измества спрямо тях.
  function gazeScore(pts, box) {
    const eyesMid = {
      x: (pts.leftEye[0].x + pts.rightEye[3].x) / 2,
      y: (pts.leftEye[0].y + pts.rightEye[3].y) / 2,
    };
    const tip = pts.nose[pts.nose.length - 1] || pts.nose[0];
    const yaw = Math.abs(tip.x - eyesMid.x) / (box.width || 1);
    const pitch = Math.abs(tip.y - eyesMid.y) / (box.height || 1);
    return Math.max(0, 1 - Math.max(0, yaw - 0.05) / 0.14) *
           Math.max(0, 1 - Math.max(0, pitch - 0.30) / 0.42);
  }

  function sizeOverlay(video, canvas) {
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  }

  async function detectOnce(video) {
    const res = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 }))
      .withFaceLandmarks(true);
    if (!res) return null;
    const lm = res.landmarks;
    return {
      box: res.detection.box,
      leftEye: lm.getLeftEye(),
      rightEye: lm.getRightEye(),
      nose: lm.getNose(),
    };
  }

  function updateSignals(found, video, now) {
    if (!found) {
      // Лицето може да липсва за миг, защото ученикът се е навел към тетрадката.
      // Гратисът пази точно този случай, вместо веднага да го брои за отсъствие.
      if (now - lastSeen > LOST_GRACE_MS) {
        scores = { eyes: 0, gaze: 0, near: 0 };
        landmarks = null;
        faceBox = null;
      }
      return;
    }
    lastSeen = now;
    landmarks = found;
    faceBox = found.box;

    const ear = (eyeAspect(found.leftEye) + eyeAspect(found.rightEye)) / 2;
    if (ear < EAR_CLOSED) {
      if (!eyesClosedSince) eyesClosedSince = now;
    } else {
      eyesClosedSince = 0;
    }
    const blinking = eyesClosedSince && (now - eyesClosedSince) < BLINK_GRACE_MS;
    const eyesOpen = (ear >= EAR_CLOSED || blinking) ? 1 : 0;

    const frac = (found.box.width * found.box.height) /
                 ((video.videoWidth * video.videoHeight) || 1);

    scores.eyes = lerp(scores.eyes, eyesOpen, SMOOTH);
    scores.gaze = lerp(scores.gaze, gazeScore(found, found.box), SMOOTH);
    scores.near = lerp(scores.near, Math.min(1, frac / MIN_FACE_FRAC), SMOOTH);
  }

  function updateState(now) {
    const present = landmarks ? 1 : 0;
    const raw = present * (0.45 * scores.eyes + 0.40 * scores.gaze + 0.15 * scores.near);
    focusScore = lerp(focusScore, raw, SMOOTH);
    if (!isFocused && focusScore >= ENTER_FOCUS) isFocused = true;
    else if (isFocused && focusScore <= LEAVE_FOCUS) isFocused = false;

    // Броим време, а не кадри: иначе бавен телефон би "учил" по-малко от бърз.
    if (lastTickAt) {
      const dt = Math.min(now - lastTickAt, 1000);
      if (isFocused) focusedMs += dt; else awayMs += dt;
    }
    lastTickAt = now;
  }

  function drawOverlay(ctx, cw, ch) {
    ctx.clearRect(0, 0, cw, ch);
    if (!drawPoints || !drawBox) return;

    const line = isFocused ? "#ffffff" : "rgba(255,255,255,0.45)";
    const w = Math.max(1.5, cw * 0.006);

    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = w;
    ctx.lineJoin = "round";

    // ъглови скоби около лицето, вместо цяла кутия — по-малко закриват образа
    const bx = drawBox.x, by = drawBox.y, bw = drawBox.width, bh = drawBox.height;
    const arm = Math.min(bw, bh) * 0.22;
    const corners = [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx + bw, by + bh, -1, -1], [bx, by + bh, 1, -1]];
    for (const c of corners) {
      ctx.beginPath();
      ctx.moveTo(c[0] + c[2] * arm, c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + c[3] * arm);
      ctx.stroke();
    }

    // очертанието на очите — това прави явно, че се следи лице, а не просто кутия
    ctx.lineWidth = Math.max(1, w * 0.7);
    for (const eye of [drawPoints.leftEye, drawPoints.rightEye]) {
      ctx.beginPath();
      eye.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }

    // лентичка отдолу: колко силен е фокусът точно сега
    const pad = cw * 0.06;
    const barW = cw - pad * 2;
    const barH = Math.max(2, ch * 0.018);
    const barY = ch - pad;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.3;
    ctx.fillRect(pad, barY, barW, barH);
    ctx.globalAlpha = 1;
    ctx.fillRect(pad, barY, barW * Math.max(0, Math.min(1, focusScore)), barH);
    ctx.restore();
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const video = $("focusVideo");
    const canvas = $("focusOverlay");
    if (!video || !canvas || !video.videoWidth || !stream) return;
    sizeOverlay(video, canvas);

    if (now - lastDetect > DETECT_MS) {
      lastDetect = now;
      detectOnce(video)
        .then(found => updateSignals(found, video, performance.now()))
        .catch(() => { /* един пропуснат кадър не е повод да спираме сесията */ });
    }
    updateState(now);

    // Нарисуваните точки догонват находката, вместо да скачат на нея — оттам
    // идва усещането, че рамката стои на лицето, а не подскача около него.
    if (landmarks && faceBox) {
      if (!drawPoints) {
        drawPoints = {
          leftEye: landmarks.leftEye.map(p => ({ x: p.x, y: p.y })),
          rightEye: landmarks.rightEye.map(p => ({ x: p.x, y: p.y })),
        };
        drawBox = { x: faceBox.x, y: faceBox.y, width: faceBox.width, height: faceBox.height };
      } else {
        for (const key of ["leftEye", "rightEye"]) {
          landmarks[key].forEach((p, i) => {
            const d = drawPoints[key][i];
            if (!d) return;
            d.x = lerp(d.x, p.x, POINT_SMOOTH);
            d.y = lerp(d.y, p.y, POINT_SMOOTH);
          });
        }
        drawBox.x = lerp(drawBox.x, faceBox.x, POINT_SMOOTH);
        drawBox.y = lerp(drawBox.y, faceBox.y, POINT_SMOOTH);
        drawBox.width = lerp(drawBox.width, faceBox.width, POINT_SMOOTH);
        drawBox.height = lerp(drawBox.height, faceBox.height, POINT_SMOOTH);
      }
    } else {
      drawPoints = null;
      drawBox = null;
    }

    drawOverlay(canvas.getContext("2d"), canvas.width, canvas.height);
  }

  function startTracking() {
    lastDetect = 0;
    lastTickAt = 0;
    lastSeen = performance.now();
    landmarks = null; drawPoints = null; faceBox = null; drawBox = null;
    eyesClosedSince = 0;
    scores = { eyes: 0, gaze: 0, near: 0 };
    focusScore = 0;
    isFocused = false;
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function stopTracking() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    const canvas = $("focusOverlay");
    if (canvas && canvas.width) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    drawPoints = null; drawBox = null; landmarks = null; faceBox = null;
  }

  function stopSession(silent) {
    stopTracking();
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
    const trackedMs = focusedMs + awayMs;
    const pct = trackedMs ? Math.round((focusedMs / trackedMs) * 100) : null;
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
