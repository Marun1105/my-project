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
  let starting = false;   // тръгва ли се точно в момента сесия — виж startSession
  let startId = 0;        // номер на опита за тръгване, за да се разпознае изоставеният

  function isEnabled() { return localStorage.getItem(ENABLED_KEY) === '1'; }

  function setEnabled(v) {
    localStorage.setItem(ENABLED_KEY, v ? '1' : '0');
    if (!v) stopSession(true);
    updateToggleUI();
  }

  // Тече ли в момента сесия: или камерата вече върви, или тъкмо се отваря.
  function sessionLive() { return !!sessionStart || starting; }

  function updateToggleUI() {
    const enabled = isEnabled();
    $('focusEnableToggle').checked = enabled;
    $('focusToggleLabel').textContent = enabled ? t('focus.onLabel') : t('focus.offLabel');
    $('focusOff').classList.toggle('hidden', enabled);
    if (enabled) {
      // Смяната на езика минава и оттук. Ако сесията върви, тя не бива да се
      // връща на началния екран: showStage само сменя класове, а камерата,
      // броячът и цикълът на разпознаване продължават невидими отзад — така
      // ученикът вижда пак "Започни сесия", лампичката свети, а изтеклото време
      // отива на вятъра при следващото тръгване. Надписите вече са преведени от
      // i18n преди това събитие, така че тук няма какво повече да се прави.
      if (!sessionLive()) showStage('Idle');
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

  function dropMedia(media) { media.getTracks().forEach(track => track.stop()); }

  async function startSession() {
    // Между натискането на бутона и отговора на камерата минава близо секунда, а
    // stream се пълни чак накрая. Дотогава втори натиск отваряше втора камера и
    // презаписваше първата — тя оставаше да свети до затварянето на раздела.
    // Флагът пропуска само едно тръгване наведнъж, а номерът разпознава опита,
    // който е бил изоставен, докато е чакал.
    if (starting || stream) return;
    starting = true;
    const attempt = ++startId;
    clearError();
    showStage('Loading');

    let media = null;
    try {
      // Кадърът се иска малко по-едър от преди: моделът така или иначе смалява
      // входа си, но наслагването се рисува в пикселите на видеото и на телефон
      // с гъст екран тънките линии иначе излизат размити.
      media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
    } catch {
      starting = false;
      setError(t('focus.errNoCamera'));
      showStage('Idle');
      return;
    }

    // Докато камерата се отваряше, ученикът може вече да е изключил фокус режима
    // или да е спрял сесията. Тогава пътечките се спират веднага — иначе
    // лампичката свети за сесия, която никой не е започвал.
    if (attempt !== startId || !isEnabled()) {
      dropMedia(media);
      starting = false;
      return;
    }

    try {
      await ensureModel();
    } catch (err) {
      dropMedia(media);
      starting = false;
      setError(err.message || t('focus.errModel'));
      showStage('Idle');
      return;
    }

    // Зареждането на модела е второ чакане, значи и второ място, на което сесията
    // може да е отпаднала под краката ни.
    if (attempt !== startId || !isEnabled()) {
      dropMedia(media);
      starting = false;
      return;
    }

    stream = media;
    starting = false;
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
  // Всяка сесия си има номер: разпознаването е обещание и може да се върне след
  // като ученикът вече е спрял сесията. Тогава номерът не съвпада и находката се
  // изхвърля, вместо да оживи рамка върху угасена камера.
  let sessionToken = 0;

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

  // Рамката на кутийката с камерата също знае дали ученикът гледа: щом наслагването
  // изсветлява, границата около него трябва да го последва, иначе двете си
  // противоречат. Класът се сменя само при смяна на състоянието, не на всеки кадър.
  function reflectFocusState() {
    if (previewEl) previewEl.classList.toggle('is-focused', isFocused);
  }

  function updateState(now) {
    const present = landmarks ? 1 : 0;
    const raw = present * (0.45 * scores.eyes + 0.40 * scores.gaze + 0.15 * scores.near);
    focusScore = lerp(focusScore, raw, SMOOTH);
    const was = isFocused;
    if (!isFocused && focusScore >= ENTER_FOCUS) isFocused = true;
    else if (isFocused && focusScore <= LEAVE_FOCUS) isFocused = false;
    if (isFocused !== was) reflectFocusState();

    // Броим време, а не кадри: иначе бавен телефон би "учил" по-малко от бърз.
    if (lastTickAt) {
      const dt = Math.min(now - lastTickAt, 1000);
      if (isFocused) focusedMs += dt; else awayMs += dt;
    }
    lastTickAt = now;
  }

  // ---------- как изглежда наслагването ----------
  //
  // Първата версия рисуваше четири прави скоби, двата многоъгълника на очите и
  // правоъгълна лентичка. Работеше, но приличаше на отладъчен изглед, а не на
  // продукт — а точно тази картинка е единственото доказателство пред ученика, че
  // фокус режимът наистина го следи. Затова тук всичко е сведено до четири тихи
  // пласта, в този ред: затъмняване настрани (лицето остава обектът), еднократно
  // помитане при хващане, мека рамка с ъгли и накрая тънка дъга под брадичката,
  // която показва колко силен е фокусът.
  //
  // Нищо не мига и нищо не щраква: всяка стойност, която се движи, минава през
  // approach(), а видимостта се води от три плавни числа — presence (има ли лице),
  // mood (гледа ли) и strength (колко силно). Така смяната на състояние е преливане,
  // а не превключване, и ученикът може спокойно да я гледа с периферното си зрение.
  const FRAME_PAD_X = 0.10;       // рамката е малко по-широка от кутията на лицето
  const FRAME_PAD_Y = 0.16;       // и по-висока, за да поеме челото и брадичката
  const SWEEP_MS = 1150;          // колко трае помитането при ново хващане
  const BREATH_MS = 5600;         // дишането на рамката — бавно, за да не дърпа окото
  const PRESENCE_RATE = 0.10;     // появяване и избледняване на лицевия пласт
  const MOOD_RATE = 0.055;        // преливане между "гледа" и "не гледа"
  const AI_PURPLE = "#a855f7";    // единственият цвят тук — началото на вълната на ClimbAI
  const AI_GLOW = "rgba(168, 85, 247, 0.5)";
  const SCRIM = "#0d0d10";        // затъмняването е фонът на приложението, не чисто черно

  let presence = 0;               // 0..1 колко "го има" лицето в кадъра
  let mood = 0;                   // 0..1 плавен преход между отсъстващ и фокусиран
  let strength = 0;               // изгладената сила на фокуса, за дъгата
  let acquiredAt = 0;             // кога беше хванато лицето — оттам тръгва помитането
  let lastFrameAt = 0;
  let previewEl = null;
  let gradCtx = null, vignetteGrad = null, sweepGrad = null;

  // Системната настройка "по-малко движение" е уважена: под нея остават само
  // спокойните преливания, без помитане, без дишане и без сияние.
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduceMotion = motionQuery ? motionQuery.matches : false;
  if (motionQuery && motionQuery.addEventListener) {
    motionQuery.addEventListener('change', e => { reduceMotion = e.matches; });
  }

  // Изглаждане, вързано за времето, а не за кадрите: на бавен телефон стъпката е
  // по-голяма, за да стигне до целта за същите милисекунди. Иначе едно и също
  // движение изглежда мързеливо на слаб телефон и рязко на бърз.
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.pow(1 - rate, dt / 16.7));
  }

  // Градиентите се правят по веднъж, в "единични" координати около нулата, и после
  // се местят с трансформация. Така на всеки кадър не се заделя нов обект —
  // рисуването е 60 пъти в секундата и точно там боклукът се натрупва най-бързо.
  function ensureGradients(ctx) {
    if (gradCtx === ctx && vignetteGrad && sweepGrad) return;
    gradCtx = ctx;
    vignetteGrad = ctx.createRadialGradient(0, 0, 0.62, 0, 0, 2.6);
    vignetteGrad.addColorStop(0, "rgba(13, 13, 16, 0)");
    vignetteGrad.addColorStop(0.45, "rgba(13, 13, 16, 0.45)");
    vignetteGrad.addColorStop(1, "rgba(13, 13, 16, 1)");
    sweepGrad = ctx.createLinearGradient(0, -1, 0, 1);
    sweepGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    sweepGrad.addColorStop(0.42, "rgba(255, 255, 255, 0.10)");
    sweepGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.85)");
    sweepGrad.addColorStop(0.58, "rgba(255, 255, 255, 0.10)");
    sweepGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  }

  // Ъглите са заоблени и с къси рамене: окото ги събира в една мека рамка около
  // лицето, докато правите скоби се четат като четири отделни знака.
  function bracketPath(ctx, x, y, w, h, r, arm) {
    const x2 = x + w, y2 = y + h;
    ctx.beginPath();
    ctx.moveTo(x + r + arm, y); ctx.lineTo(x + r, y);
    ctx.arcTo(x, y, x, y + r, r); ctx.lineTo(x, y + r + arm);
    ctx.moveTo(x2 - r - arm, y); ctx.lineTo(x2 - r, y);
    ctx.arcTo(x2, y, x2, y + r, r); ctx.lineTo(x2, y + r + arm);
    ctx.moveTo(x2, y2 - r - arm); ctx.lineTo(x2, y2 - r);
    ctx.arcTo(x2, y2, x2 - r, y2, r); ctx.lineTo(x2 - r - arm, y2);
    ctx.moveTo(x, y2 - r - arm); ctx.lineTo(x, y2 - r);
    ctx.arcTo(x, y2, x + r, y2, r); ctx.lineTo(x + r + arm, y2);
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const x2 = x + w, y2 = y + h;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x2 - r, y); ctx.arcTo(x2, y, x2, y + r, r);
    ctx.lineTo(x2, y2 - r); ctx.arcTo(x2, y2, x2 - r, y2, r);
    ctx.lineTo(x + r, y2); ctx.arcTo(x, y2, x, y2 - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // Очите се затварят като гладка крива през точките: върховете стават контролни
  // точки, а среднините — опорни. Правите отсечки издаваха, че това са шест
  // измерени числа; кривата изглежда като око и пак се сплесква при мигане.
  function eyeCurvePath(ctx, pts) {
    const n = pts.length;
    if (n < 3) return;
    ctx.moveTo((pts[n - 1].x + pts[0].x) / 2, (pts[n - 1].y + pts[0].y) / 2);
    for (let i = 0; i < n; i++) {
      const cur = pts[i], nxt = pts[(i + 1) % n];
      ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) / 2, (cur.y + nxt.y) / 2);
    }
    ctx.closePath();
  }

  // Докато лице няма, стои една много бледа рамка в средата: показва къде да
  // застане ученикът и пази наслагването да не е празно, без да мърда.
  function drawGuide(ctx, cw, ch, fade) {
    const gw = cw * 0.42, gh = ch * 0.60;
    const gx = (cw - gw) / 2, gy = ch * 0.16;
    const m = Math.min(gw, gh);
    ctx.save();
    ctx.globalAlpha = fade * 0.16;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, Math.min(cw, ch) * 0.006);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    bracketPath(ctx, gx, gy, gw, gh, m * 0.30, m * 0.10);
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlay(ctx, cw, ch, now, dt) {
    ctx.clearRect(0, 0, cw, ch);
    ensureGradients(ctx);

    const here = (landmarks && drawBox && drawPoints) ? 1 : 0;
    presence = approach(presence, here, PRESENCE_RATE, dt);
    mood = approach(mood, isFocused ? 1 : 0, MOOD_RATE, dt);
    strength = approach(strength, Math.max(0, Math.min(1, focusScore)), 0.14, dt);

    if (presence < 0.98) drawGuide(ctx, cw, ch, 1 - presence);
    if (presence < 0.004 || !drawBox || !drawPoints) return;

    const unit = Math.min(cw, ch);
    const breath = reduceMotion ? 0 : Math.sin((now / BREATH_MS) * Math.PI * 2);

    // Рамката стои около кутията на лицето, но малко по-широка и по-висока, и
    // диша едва забележимо — по-силно, когато ученикът е фокусиран.
    const grow = 1 + breath * 0.012 * (0.4 + 0.6 * mood);
    const fw = drawBox.width * (1 + FRAME_PAD_X * 2) * grow;
    const fh = drawBox.height * (1 + FRAME_PAD_Y * 2) * grow;
    const cx = drawBox.x + drawBox.width / 2;
    const cy = drawBox.y + drawBox.height / 2;
    const fx = cx - fw / 2, fy = cy - fh / 2;
    const m = Math.min(fw, fh);

    // 1. Настрани се затъмнява: ученикът остава осветеният обект в кадъра.
    const vs = Math.max(fw, fh) * 0.5;
    ctx.save();
    ctx.globalAlpha = presence * (0.30 + 0.22 * mood);
    ctx.translate(cx, cy);
    ctx.scale(vs, vs);
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(-cx / vs, -cy / vs, cw / vs, ch / vs);
    ctx.restore();

    // 2. Помитане — само първата секунда след хващане, после рамката се уталожва.
    const sweep = reduceMotion ? 1 : Math.min(1, (now - acquiredAt) / SWEEP_MS);
    if (sweep < 1) {
      const eased = sweep * sweep * (3 - 2 * sweep);
      const band = fh * 0.34;
      ctx.save();
      ctx.globalAlpha = presence * Math.sin(Math.PI * sweep) * 0.55;
      roundRectPath(ctx, fx, fy, fw, fh, m * 0.30);
      ctx.clip();
      ctx.translate(0, fy + fh * eased);
      ctx.scale(1, band / 2);
      ctx.fillStyle = sweepGrad;
      ctx.fillRect(fx, -1, fw, 2);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 3. Самата рамка: по-плътна, когато лицето е насочено към тетрадката.
    ctx.globalAlpha = presence * (0.34 + 0.46 * mood);
    ctx.lineWidth = Math.max(1.1, unit * 0.0075);
    bracketPath(ctx, fx, fy, fw, fh, m * 0.30, m * 0.12 * (1 + 0.12 * breath));
    ctx.stroke();

    // Очите — те правят явно, че се следи лице, а не просто правоъгълник.
    ctx.globalAlpha = presence * (0.26 + 0.40 * mood);
    ctx.lineWidth = Math.max(0.9, unit * 0.0045);
    ctx.beginPath();
    eyeCurvePath(ctx, drawPoints.leftEye);
    eyeCurvePath(ctx, drawPoints.rightEye);
    ctx.stroke();

    // 4. Силата на фокуса: тънка дъга под брадичката, която расте от средата на
    // двете страни. Правоъгълната лента изглеждаше като зареждане на файл;
    // дъгата принадлежи на лицето, защото е част от същата окръжност.
    const R = fh * 0.5 + m * 0.13;
    const HALF = 0.52;                  // около 30° на страна
    const mid = Math.PI / 2;            // долната среда на окръжността
    ctx.lineWidth = Math.max(1, unit * 0.009);
    ctx.globalAlpha = presence * 0.20;
    ctx.beginPath();
    ctx.arc(cx, cy, R, mid - HALF, mid + HALF);
    ctx.stroke();

    if (strength > 0.02) {
      ctx.globalAlpha = presence * (0.6 + 0.4 * mood);
      ctx.strokeStyle = AI_PURPLE;
      if (!reduceMotion && mood > 0.05) {
        ctx.shadowColor = AI_GLOW;
        ctx.shadowBlur = unit * 0.045 * mood;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R, mid - HALF * strength, mid + HALF * strength);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const video = $("focusVideo");
    const canvas = $("focusOverlay");
    if (!video || !canvas || !video.videoWidth || !stream) return;
    sizeOverlay(video, canvas);

    // Клампът пази от скок, ако разделът е бил скрит: при връщане между двата
    // кадъра са минали секунди и без него всичко изгладено би щракнало наведнъж.
    const dt = lastFrameAt ? Math.min(now - lastFrameAt, 64) : 16.7;
    lastFrameAt = now;

    if (now - lastDetect > DETECT_MS) {
      lastDetect = now;
      const token = sessionToken;
      detectOnce(video)
        .then(found => {
          if (token === sessionToken && stream) updateSignals(found, video, performance.now());
        })
        .catch(() => { /* един пропуснат кадър не е повод да спираме сесията */ });
    }
    updateState(now);

    // Нарисуваните точки догонват находката, вместо да скачат на нея — оттам
    // идва усещането, че рамката стои на лицето, а не подскача около него.
    if (landmarks && faceBox) {
      const k = 1 - Math.pow(1 - POINT_SMOOTH, dt / 16.7);
      if (!drawPoints || drawPoints.leftEye.length !== landmarks.leftEye.length) {
        drawPoints = {
          leftEye: landmarks.leftEye.map(p => ({ x: p.x, y: p.y })),
          rightEye: landmarks.rightEye.map(p => ({ x: p.x, y: p.y })),
        };
        drawBox = { x: faceBox.x, y: faceBox.y, width: faceBox.width, height: faceBox.height };
        acquiredAt = now;   // ново хващане — оттук тръгва еднократното помитане
      } else {
        for (const key of ["leftEye", "rightEye"]) {
          landmarks[key].forEach((p, i) => {
            const d = drawPoints[key][i];
            if (!d) return;
            d.x = lerp(d.x, p.x, k);
            d.y = lerp(d.y, p.y, k);
          });
        }
        drawBox.x = lerp(drawBox.x, faceBox.x, k);
        drawBox.y = lerp(drawBox.y, faceBox.y, k);
        drawBox.width = lerp(drawBox.width, faceBox.width, k);
        drawBox.height = lerp(drawBox.height, faceBox.height, k);
      }
    } else if (presence < 0.01) {
      // Геометрията нарочно се пази, докато рамката избледнява: така изчезването
      // е преливане на място, а не рязко изгасване. Чисти се чак когато е невидима.
      drawPoints = null;
      drawBox = null;
    }

    drawOverlay(canvas.getContext("2d"), canvas.width, canvas.height, now, dt);
  }

  function startTracking() {
    sessionToken++;
    lastDetect = 0;
    lastTickAt = 0;
    lastFrameAt = 0;
    lastSeen = performance.now();
    landmarks = null; drawPoints = null; faceBox = null; drawBox = null;
    eyesClosedSince = 0;
    scores = { eyes: 0, gaze: 0, near: 0 };
    focusScore = 0;
    isFocused = false;
    presence = 0; mood = 0; strength = 0; acquiredAt = 0;
    previewEl = $("focusOverlay") ? $("focusOverlay").parentElement : null;
    reflectFocusState();
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function stopTracking() {
    sessionToken++;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    const canvas = $("focusOverlay");
    if (canvas && canvas.width) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    drawPoints = null; drawBox = null; landmarks = null; faceBox = null;
    presence = 0; mood = 0; strength = 0;
    isFocused = false;
    reflectFocusState();
    previewEl = null;
  }

  function stopSession(silent) {
    startId++;   // ако точно сега се отваря камера, тя вече е ненужна
    stopTracking();
    if (stream) { dropMedia(stream); stream = null; }
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

    // Ако нищо не е било измерено (сесията е свършила, преди камерата да проработи),
    // процент няма — тогава се казва само колко е траяла. Проверката е през самия
    // pct, за да не може по-долните прагове да получат null и да сравняват с него.
    let message;
    if (pct === null) {
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

    // Излизането от раздела приключва сесията. Досега единственият начин да се
    // спре камерата беше бутонът "Приключи": натиснеш ли раздел в менюто, видеото
    // остава живо на скрит елемент, разпознаването продължава да яде батерия и
    // лампичката до камерата свети за сесия, която ученикът е напуснал.
    //
    // Освен това точно тогава scanner.js иска СВОЯТА камера за изгледа на учителя.
    // На телефон втората заявка се блъска в първата и ученикът вижда "няма достъп
    // до камера, качи снимка" — при напълно изправна камера, заета от нас самите.
    //
    // Сесията се записва (silent=false би показал обобщението на екран, който вече
    // не се гледа), защото ученикът наистина е учил дотук.
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view !== 'focus' && sessionLive()) stopSession(true);
    });
    // Затваряне на таба е същото като излизане — иначе камерата остава заета,
    // докато браузърът не реши да освободи страницата.
    window.addEventListener('pagehide', () => { if (sessionLive()) stopSession(true); });

    updateToggleUI();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Focus.init);
