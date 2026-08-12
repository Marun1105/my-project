// scanner.js — камера, намиране на ръбовете на страницата и изправяне (opencv.js)
const Scanner = (() => {
  const $ = id => document.getElementById(id);
  let cvReady = false;
  let scannedDataUrl = null;

  // opencv.js вика тази функция, когато е готово (виж <script onload> в index.html)
  function onCvReady() {
    if (window.cv && cv.getBuildInformation) {
      cvReady = true;
    } else if (window.cv) {
      cv['onRuntimeInitialized'] = () => { cvReady = true; };
    }
  }
  window.onCvReady = onCvReady;

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      $('video').srcObject = stream;
      $('splash').classList.add('hidden');
      $('stage').classList.remove('hidden');
      $('controls').classList.remove('hidden');
    } catch (err) {
      $('splash').querySelector('.loading-text').textContent = t('scanner.noCameraAccess');
    }
  }

  function showStatus(text) {
    const s = $('status');
    s.textContent = text;
    s.classList.remove('hidden');
  }
  function hideStatus() { $('status').classList.add('hidden'); }

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

  function warpToPage(src, c) {
    const wTop = Math.hypot(c.tr.x - c.tl.x, c.tr.y - c.tl.y);
    const wBot = Math.hypot(c.br.x - c.bl.x, c.br.y - c.bl.y);
    const hL = Math.hypot(c.bl.x - c.tl.x, c.bl.y - c.tl.y);
    const hR = Math.hypot(c.br.x - c.tr.x, c.br.y - c.tr.y);
    const W = Math.max(wTop, wBot), H = Math.max(hL, hR);

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

  function fromDataUrl(dataUrl) {
    // качена снимка от галерия/файл — влиза направо в прегледа, без камера
    scannedDataUrl = dataUrl;
    $('video').classList.add('hidden');
    const img = $('result');
    img.src = dataUrl;
    img.classList.remove('hidden');
    $('splash').classList.add('hidden');
    $('stage').classList.remove('hidden');
    $('controls').classList.remove('hidden');
    $('shootBtn').classList.add('hidden');
    $('retakeBtn').classList.remove('hidden');
    $('useBtn').classList.remove('hidden');
    showStatus(t('scanner.uploaded'));
  }

  function capture() {
    const video = $('video');
    const cap = $('capture');
    cap.width = video.videoWidth;
    cap.height = video.videoHeight;
    cap.getContext('2d').drawImage(video, 0, 0);

    let resultDataUrl;
    if (cvReady) {
      const src = cv.imread(cap);
      const corners = findPageCorners(src);
      if (corners) {
        const warped = warpToPage(src, corners);
        const out = $('output');
        cv.imshow(out, warped);
        resultDataUrl = out.toDataURL('image/jpeg', 0.9);
        warped.delete();
        showStatus(t('scanner.foundEdges'));
      } else {
        resultDataUrl = cap.toDataURL('image/jpeg', 0.9);
        showStatus(t('scanner.noEdges'));
      }
      src.delete();
    } else {
      resultDataUrl = cap.toDataURL('image/jpeg', 0.9);
      showStatus(t('scanner.ready'));
    }

    $('video').classList.add('hidden');
    const img = $('result');
    img.src = resultDataUrl;
    img.classList.remove('hidden');
    $('shootBtn').classList.add('hidden');
    $('retakeBtn').classList.remove('hidden');
    $('useBtn').classList.remove('hidden');

    scannedDataUrl = resultDataUrl;
  }

  function retake() {
    $('result').classList.add('hidden');
    $('video').classList.remove('hidden');
    $('shootBtn').classList.remove('hidden');
    $('retakeBtn').classList.add('hidden');
    $('useBtn').classList.add('hidden');
    hideStatus();
  }

  function useImage() {
    hideStatus();
    window.dispatchEvent(new CustomEvent('climby:scan-ready', { detail: { dataUrl: scannedDataUrl } }));
  }

  function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => fromDataUrl(reader.result);
    reader.readAsDataURL(file);
  }

  function init() {
    $('shootBtn').addEventListener('click', capture);
    $('retakeBtn').addEventListener('click', retake);
    $('useBtn').addEventListener('click', useImage);
    $('uploadInput').addEventListener('change', handleFileUpload);
    start();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Scanner.init);
