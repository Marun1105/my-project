// scanner.js — камера, ръчно коригиране на ъглите (влачене), филтри и сканиране на няколко страници наведнъж.
// Стъпки: Камера → Снимай → Коригирай ъглите → Избери филтър → Добави страница → (по избор) снимай пак →
// „Питай за N страници“ праща всички избрани страници заедно на AI учителя (виж tutor.js).
const Scanner = (() => {
  const $ = id => document.getElementById(id);
  let cvReady = false;

  // opencv.js вика тази функция, когато е готово (виж <script onload> в index.html)
  function onCvReady() {
    if (window.cv && cv.getBuildInformation) {
      cvReady = true;
    } else if (window.cv) {
      cv['onRuntimeInitialized'] = () => { cvReady = true; };
    }
  }
  window.onCvReady = onCvReady;

  // ---------- състояние ----------
  const pages = []; // { dataUrl } за всяка потвърдена страница, в реда на добавяне
  let rawW = 0, rawH = 0;        // естествен размер на суровата снимка (преди изрязване)
  let screenCorners = null;      // {tl,tr,br,bl} в пиксели спрямо #adjustWrap, докато потребителят влачи
  let dispRect = null;           // изчислен правоъгълник къде точно се показва снимката вътре в #adjustWrap (object-fit: contain)
  let warpedMat = null;          // cv.Mat на изправената страница (след потвърждаване на ъглите), преди филтър
  let rawCropCanvas = null;      // резервен вариант: обикновен canvas с изрязаната снимка, ако opencv.js още не се е заредило
  let currentFilter = 'original';
  let pendingDataUrl = null;     // резултат от текущия филтър — това се добавя към pages[] при "Добави страница"

  // Страниците се пращат към AI като base64 — свиваме ги до размер, който моделът
  // и без това ползва (~1568px по дългата страна). Пести трафик на мобилни данни и
  // време за качване, без видима загуба на четимост на текста.
  const MAX_UPLOAD_DIM = 1568;
  const UPLOAD_QUALITY = 0.82;

  function toCompressedDataUrl(canvas) {
    const longest = Math.max(canvas.width, canvas.height);
    if (longest <= MAX_UPLOAD_DIM) {
      return canvas.toDataURL('image/jpeg', UPLOAD_QUALITY);
    }
    const scale = MAX_UPLOAD_DIM / longest;
    const small = document.createElement('canvas');
    small.width = Math.round(canvas.width * scale);
    small.height = Math.round(canvas.height * scale);
    const ctx = small.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    return small.toDataURL('image/jpeg', UPLOAD_QUALITY);
  }

  let hasCamera = true;
  let stream = null;          // живият поток от камерата, за да може да се спре
  let stage = 'cameraStage';  // кой етап се вижда сега — при връщане в раздела не прекъсваме започнато изрязване

  function showStage(id) {
    stage = id;
    ['cameraStage', 'adjustStage', 'filterStage'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
    const onCamera = id === 'cameraStage';
    // Без камера панелът за качване заема мястото на визьора — но само на този
    // етап, иначе би останал видим зад редактирането на снимката.
    const showNoCamera = onCamera && !hasCamera;
    $('noCamera').classList.toggle('hidden', !showNoCamera);
    if (showNoCamera) $('cameraStage').classList.add('hidden');
    $('controls').classList.toggle('hidden', !onCamera || !hasCamera);
    $('scannerHint').classList.toggle('hidden', !onCamera || !hasCamera);
    $('uploadRow').classList.toggle('hidden', !onCamera || !hasCamera);
  }

  // ---------- камера ----------
  async function start() {
    if (stream) return; // вече върви — второ извикване би поискало камерата пак
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      $('video').srcObject = stream;
      hasCamera = true;
      $('splash').classList.add('hidden');
      showStage('cameraStage');
      startEdgeOverlay();
    } catch (err) {
      // Няма камера (обичайно на настолен компютър) — качването на файл не е
      // резервен вариант при грешка, а равностоен път, затова го показваме така.
      hasCamera = false;
      $('splash').classList.add('hidden');
      showStage('cameraStage');
    }
  }

  // Скриването на раздела не спира камерата само по себе си — лампичката до нея
  // остава светната, докато потребителят чете в "Чеклист". Затова я гасим изрично.
  function stop() {
    stopEdgeOverlay();
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    $('video').srcObject = null;
  }

  // Връщане на визьора. Камерата може да е угасена, ако междувременно сме били
  // в друг раздел, затова се пали пак — start() сам се отказва, ако вече върви.
  function backToCamera() {
    showStage('cameraStage');
    start();
  }


  // ---------- жива рамка около страницата ----------
  // Същото разпознаване, което се ползва при снимане, но пуснато върху живия
  // образ. Не е AI и не пита сървъра — Canny + търсене на най-големия
  // четириъгълник, точно както при натискане на копчето. Рисува се на отделен
  // canvas върху видеото.
  //
  // Три неща я правят гледаема, вместо да подскача:
  //   • работи върху смален кадър (детекцията е скъпа, а ъглите не се нуждаят
  //     от повече точност, отколкото окото вижда);
  //   • ъглите се движат плавно към новите, а не скачат;
  //   • ако за няколко кадъра нищо не се намери, рамката избледнява, вместо да
  //     изчезне рязко.
  const EDGE_W = 360;             // ширина на кадъра, върху който търсим
  const EDGE_EVERY_MS = 90;       // колко често търсим наново
  const EDGE_SMOOTH = 0.35;       // 0 = не мърда, 1 = скача веднага
  const EDGE_FORGIVE = 6;         // толкова кадъра без находка още държим рамката

  let edgeCanvas = null;          // смаленото копие, върху което търсим
  let edgeRaf = null;
  let edgeLastFind = 0;
  let edgeCorners = null;         // изгладените ъгли, в координати на видеото
  let edgeMisses = 0;
  let edgeDash = 0;

  function _lerpPt(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  // Къде точно стои видеото вътре в кутията си (object-fit: cover реже краищата).
  function _videoBox(video, cw, ch) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.max(cw / vw, ch / vh);
    const w = vw * scale, h = vh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, scale };
  }

  function _findLiveCorners(video) {
    if (!cvReady || !window.cv) return null;
    if (!edgeCanvas) edgeCanvas = document.createElement('canvas');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    edgeCanvas.width = EDGE_W;
    edgeCanvas.height = Math.round(EDGE_W * vh / vw);
    edgeCanvas.getContext('2d').drawImage(video, 0, 0, edgeCanvas.width, edgeCanvas.height);
    let src = null, found = null;
    try {
      src = cv.imread(edgeCanvas);
      found = findPageCorners(src);
    } catch {
      found = null;              // OpenCV още се зарежда или кадърът е празен
    } finally {
      if (src) src.delete();
    }
    if (!found) return null;
    // обратно в координати на самото видео
    const k = vw / edgeCanvas.width;
    const out = {};
    for (const key of ['tl', 'tr', 'br', 'bl']) out[key] = { x: found[key].x * k, y: found[key].y * k };
    return out;
  }

  function _drawEdge(ctx, pts, cw, ch, alpha) {
    ctx.clearRect(0, 0, cw, ch);
    if (!pts) return;
    const order = ['tl', 'tr', 'br', 'bl'];
    ctx.save();
    ctx.globalAlpha = alpha;

    // Дебела тъмна основа отдолу: върху бяла страница тънка светла линия се губи.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    order.forEach((k, i) => (i ? ctx.lineTo(pts[k].x, pts[k].y) : ctx.moveTo(pts[k].x, pts[k].y)));
    ctx.closePath();
    ctx.stroke();

    // Отгоре — движещият се пунктир. Той дава усещането, че рамката "живее"
    // и се прехваща наново при всяко местене на телефона.
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([14, 9]);
    ctx.lineDashOffset = -edgeDash;
    ctx.beginPath();
    order.forEach((k, i) => (i ? ctx.lineTo(pts[k].x, pts[k].y) : ctx.moveTo(pts[k].x, pts[k].y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Ъглите се маркират отделно — окото ги ползва, за да центрира листа.
    const arm = Math.max(16, Math.min(cw, ch) * 0.05);
    ctx.lineWidth = 3;
    order.forEach((k, i) => {
      const p = pts[k];
      const prev = pts[order[(i + 3) % 4]];
      const next = pts[order[(i + 1) % 4]];
      for (const nb of [prev, next]) {
        const dx = nb.x - p.x, dy = nb.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (dx / len) * arm, p.y + (dy / len) * arm);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  function _edgeTick(now) {
    edgeRaf = requestAnimationFrame(_edgeTick);
    const canvas = $('edgeOverlay');
    const video = $('video');
    if (!canvas || !video || !stream || stage !== 'cameraStage') return;

    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }

    if (now - edgeLastFind > EDGE_EVERY_MS) {
      edgeLastFind = now;
      const found = _findLiveCorners(video);
      if (found) {
        edgeMisses = 0;
        edgeCorners = edgeCorners
          ? Object.fromEntries(['tl','tr','br','bl'].map(k => [k, _lerpPt(edgeCorners[k], found[k], EDGE_SMOOTH)]))
          : found;
      } else if (++edgeMisses > EDGE_FORGIVE) {
        edgeCorners = null;
      }
    }

    edgeDash = (edgeDash + 0.9) % 23;
    const box = _videoBox(video, cw, ch);
    const ctx = canvas.getContext('2d');
    if (!edgeCorners || !box) { ctx.clearRect(0, 0, cw, ch); return; }
    const onScreen = {};
    for (const k of ['tl','tr','br','bl']) {
      onScreen[k] = { x: box.x + edgeCorners[k].x * box.scale, y: box.y + edgeCorners[k].y * box.scale };
    }
    _drawEdge(ctx, onScreen, cw, ch, Math.max(0, 1 - edgeMisses / (EDGE_FORGIVE + 1)));
  }

  function startEdgeOverlay() {
    // Хора, които са помолили за по-малко движение, получават рамка без пунктир —
    // спираме анимацията, не разпознаването.
    if (edgeRaf === null) edgeRaf = requestAnimationFrame(_edgeTick);
  }

  function stopEdgeOverlay() {
    if (edgeRaf !== null) { cancelAnimationFrame(edgeRaf); edgeRaf = null; }
    edgeCorners = null;
    edgeMisses = 0;
    const canvas = $('edgeOverlay');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  function captureRawCanvas() {
    const video = $('video');
    const cap = $('capture');
    cap.width = video.videoWidth;
    cap.height = video.videoHeight;
    cap.getContext('2d').drawImage(video, 0, 0);
    return cap;
  }

  function capture() {
    enterAdjustStage(captureRawCanvas());
  }

  function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const cap = $('capture');
        cap.width = img.naturalWidth;
        cap.height = img.naturalHeight;
        cap.getContext('2d').drawImage(img, 0, 0);
        enterAdjustStage(cap);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  // ---------- стъпка 2: коригиране на ъглите ----------

  // Намира най-големия четириъгълен контур = страницата. Връща подредени ъгли или null.
  function findPageCorners(src) {
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 75, 200);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null, bestArea = 0;
    const imgArea = src.rows * src.cols;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      const area = cv.contourArea(approx);
      if (approx.rows === 4 && area > bestArea && area > imgArea * 0.2) {
        bestArea = area;
        if (best) best.delete();
        best = approx;
      } else {
        approx.delete();
      }
      c.delete();
    }

    gray.delete(); blur.delete(); edges.delete();
    contours.delete(); hierarchy.delete();

    if (!best) return null;
    const pts = [];
    for (let i = 0; i < 4; i++) pts.push({ x: best.intPtr(i, 0)[0], y: best.intPtr(i, 0)[1] });
    best.delete();
    return orderCorners(pts);
  }

  // подрежда ъглите: горе-ляво, горе-дясно, долу-дясно, долу-ляво
  function orderCorners(pts) {
    const sum = pts.map(p => p.x + p.y);
    const diff = pts.map(p => p.x - p.y);
    return {
      tl: pts[sum.indexOf(Math.min(...sum))],
      br: pts[sum.indexOf(Math.max(...sum))],
      tr: pts[diff.indexOf(Math.max(...diff))],
      bl: pts[diff.indexOf(Math.min(...diff))],
    };
  }

  function fullFrameCorners() {
    return { tl: { x: 0, y: 0 }, tr: { x: rawW, y: 0 }, br: { x: rawW, y: rawH }, bl: { x: 0, y: rawH } };
  }

  function detectCorners(canvas) {
    if (!cvReady) return fullFrameCorners();
    const src = cv.imread(canvas);
    const found = findPageCorners(src);
    src.delete();
    return found || fullFrameCorners();
  }

  function computeDispRect() {
    const wrap = $('adjustWrap');
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    const imgRatio = rawW / rawH;
    const boxRatio = cw / ch;
    let w, h;
    if (imgRatio > boxRatio) { w = cw; h = cw / imgRatio; } else { h = ch; w = ch * imgRatio; }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  function naturalToScreen(pt) {
    return { x: dispRect.x + (pt.x / rawW) * dispRect.w, y: dispRect.y + (pt.y / rawH) * dispRect.h };
  }
  function screenToNatural(pt) {
    return { x: Math.max(0, Math.min(rawW, ((pt.x - dispRect.x) / dispRect.w) * rawW)),
             y: Math.max(0, Math.min(rawH, ((pt.y - dispRect.y) / dispRect.h) * rawH)) };
  }

  function enterAdjustStage(rawCanvas) {
    rawW = rawCanvas.width;
    rawH = rawCanvas.height;
    $('adjustImg').src = rawCanvas.toDataURL('image/jpeg', 0.92);
    showStage('adjustStage');

    requestAnimationFrame(() => {
      dispRect = computeDispRect();
      setCorners(detectCorners(rawCanvas));
    });
  }

  function setCorners(naturalCorners) {
    screenCorners = {
      tl: naturalToScreen(naturalCorners.tl),
      tr: naturalToScreen(naturalCorners.tr),
      br: naturalToScreen(naturalCorners.br),
      bl: naturalToScreen(naturalCorners.bl),
    };
    renderAdjustOverlay();
  }

  function renderAdjustOverlay() {
    ['TL', 'TR', 'BR', 'BL'].forEach(k => {
      const pt = screenCorners[k.toLowerCase()];
      const el = $(`corner${k}`);
      el.style.left = pt.x + 'px';
      el.style.top = pt.y + 'px';
    });
    const order = ['tl', 'tr', 'br', 'bl'];
    const points = order.map(k => `${screenCorners[k].x},${screenCorners[k].y}`).join(' ');
    $('adjustPoly').setAttribute('points', points);
  }

  function makeDraggable(handleId, key) {
    const handle = $(handleId);
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const wrap = $('adjustWrap');
      const onMove = ev => {
        const rect = wrap.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
        screenCorners[key] = { x, y };
        renderAdjustOverlay();
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  function confirmAdjust() {
    const natural = {
      tl: screenToNatural(screenCorners.tl),
      tr: screenToNatural(screenCorners.tr),
      br: screenToNatural(screenCorners.br),
      bl: screenToNatural(screenCorners.bl),
    };

    if (warpedMat) { warpedMat.delete(); warpedMat = null; }
    rawCropCanvas = null;

    if (cvReady && window.cv) {
      const src = cv.imread($('capture'));
      warpedMat = warpToPage(src, natural);
      src.delete();
    } else {
      // opencv.js още не се е заредило (голям файл) — изрязваме правоъгълника около
      // избраните ъгли вместо перспективна корекция, без да спираме ученика да продължи
      const xs = [natural.tl.x, natural.tr.x, natural.br.x, natural.bl.x];
      const ys = [natural.tl.y, natural.tr.y, natural.br.y, natural.bl.y];
      const bx = Math.min(...xs), by = Math.min(...ys);
      const bw = Math.max(1, Math.round(Math.max(...xs) - bx));
      const bh = Math.max(1, Math.round(Math.max(...ys) - by));
      rawCropCanvas = document.createElement('canvas');
      rawCropCanvas.width = bw;
      rawCropCanvas.height = bh;
      rawCropCanvas.getContext('2d').drawImage($('capture'), bx, by, bw, bh, 0, 0, bw, bh);
    }

    currentFilter = 'original';
    document.querySelectorAll('.filter-swatch').forEach(b => b.classList.toggle('active', b.dataset.filter === 'original'));
    renderFilterPreview();
    showStage('filterStage');
  }

  function warpToPage(src, c) {
    const wTop = Math.hypot(c.tr.x - c.tl.x, c.tr.y - c.tl.y);
    const wBot = Math.hypot(c.br.x - c.bl.x, c.br.y - c.bl.y);
    const hL = Math.hypot(c.bl.x - c.tl.x, c.bl.y - c.tl.y);
    const hR = Math.hypot(c.br.x - c.tr.x, c.br.y - c.tr.y);
    const W = Math.max(wTop, wBot, 1), H = Math.max(hL, hR, 1);

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [c.tl.x, c.tl.y, c.tr.x, c.tr.y, c.br.x, c.br.y, c.bl.x, c.bl.y]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(W, H));
    srcTri.delete(); dstTri.delete(); M.delete();
    return dst;
  }

  // ---------- стъпка 3: филтър ----------
  function renderFilterPreview() {
    const out = $('output');
    if (warpedMat) {
      if (currentFilter === 'bw') {
        const gray = new cv.Mat();
        cv.cvtColor(warpedMat, gray, cv.COLOR_RGBA2GRAY);
        cv.imshow(out, gray);
        gray.delete();
      } else if (currentFilter === 'enhanced') {
        const enhanced = new cv.Mat();
        warpedMat.convertTo(enhanced, -1, 1.25, 12);
        cv.imshow(out, enhanced);
        enhanced.delete();
      } else {
        cv.imshow(out, warpedMat);
      }
    } else if (rawCropCanvas) {
      // резервен вариант без opencv.js: същите филтри, но през обикновен canvas пиксел по пиксел
      out.width = rawCropCanvas.width;
      out.height = rawCropCanvas.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(rawCropCanvas, 0, 0);
      if (currentFilter !== 'original') {
        const imgData = ctx.getImageData(0, 0, out.width, out.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          if (currentFilter === 'bw') {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            d[i] = d[i + 1] = d[i + 2] = g;
          } else {
            d[i] = Math.min(255, d[i] * 1.25 + 12);
            d[i + 1] = Math.min(255, d[i + 1] * 1.25 + 12);
            d[i + 2] = Math.min(255, d[i + 2] * 1.25 + 12);
          }
        }
        ctx.putImageData(imgData, 0, 0);
      }
    } else {
      return;
    }
    pendingDataUrl = toCompressedDataUrl(out);
    $('filterPreview').src = pendingDataUrl;
  }

  function selectFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-swatch').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    renderFilterPreview();
  }

  function addPage() {
    if (!pendingDataUrl) return;
    pages.push({ dataUrl: pendingDataUrl });
    if (warpedMat) { warpedMat.delete(); warpedMat = null; }
    rawCropCanvas = null;
    pendingDataUrl = null;
    renderPageStrip();
    backToCamera();
  }

  function retakeToCamera() {
    if (warpedMat) { warpedMat.delete(); warpedMat = null; }
    rawCropCanvas = null;
    pendingDataUrl = null;
    backToCamera();
  }

  // ---------- страници (batch) ----------
  function renderPageStrip() {
    const strip = $('pageStrip');
    const thumbs = $('pageThumbs');
    thumbs.innerHTML = '';

    pages.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'page-thumb';
      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.alt = '';
      const num = document.createElement('span');
      num.className = 'page-thumb-num';
      num.textContent = String(i + 1);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'page-thumb-remove';
      del.setAttribute('aria-label', t('scanner.removePage'));
      del.textContent = '✕';
      del.addEventListener('click', () => { pages.splice(i, 1); renderPageStrip(); });
      div.appendChild(img);
      div.appendChild(num);
      div.appendChild(del);
      thumbs.appendChild(div);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'page-thumb-add';
    add.setAttribute('aria-label', t('scanner.addAnother'));
    add.textContent = '+';
    add.addEventListener('click', backToCamera);
    thumbs.appendChild(add);

    strip.classList.toggle('hidden', pages.length === 0);
    const n = pages.length;
    $('pagesDoneLabel').textContent = t('scanner.askAboutPages', {
      n, pages: n === 1 ? t('scanner.pageOne') : t('scanner.pageMany'),
    });
  }

  function finishPages() {
    if (pages.length === 0) return;
    window.dispatchEvent(new CustomEvent('climby:scan-ready', { detail: { dataUrls: pages.map(p => p.dataUrl) } }));
  }

  function init() {
    $('shootBtn').addEventListener('click', capture);
    $('uploadInput').addEventListener('change', handleFileUpload);
    $('noCameraUploadBtn').addEventListener('click', () => $('uploadInput').click());

    makeDraggable('cornerTL', 'tl');
    makeDraggable('cornerTR', 'tr');
    makeDraggable('cornerBR', 'br');
    makeDraggable('cornerBL', 'bl');
    $('adjustAutoBtn').addEventListener('click', () => setCorners(detectCorners($('capture'))));
    $('adjustConfirmBtn').addEventListener('click', confirmAdjust);
    $('adjustRetakeBtn').addEventListener('click', backToCamera);

    document.querySelectorAll('.filter-swatch').forEach(btn => {
      btn.addEventListener('click', () => selectFilter(btn.dataset.filter));
    });
    $('filterAddBtn').addEventListener('click', addPage);
    $('filterRetakeBtn').addEventListener('click', retakeToCamera);

    $('pagesDoneBtn').addEventListener('click', finishPages);
    window.addEventListener('climby:lang-changed', renderPageStrip);

    // Камерата върви само докато разделът "Учител" се гледа. При връщане я палим
    // пак, но само ако сме на визьора — иначе бихме изхвърлили започнато изрязване.
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view !== 'tutor') stop();
      else if (stage === 'cameraStage') start();
    });
    // Затварянето на прозореца/раздела не винаги минава по горния път.
    window.addEventListener('pagehide', stop);

    start();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Scanner.init);
