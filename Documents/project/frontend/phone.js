// phone.js — страната на компютъра: свързва телефон и прибира снимките от него.
//
// Защо съществува: на лаптоп камера или няма, или е обърната към лицето и не
// става за страница от учебник. Телефонът в джоба е по-добрият скенер — тук е
// само пътят снимката да стигне до екрана, на който детето пише.
//
// Свързването е еднократно: сканираш QR кода веднъж, потвърждаваш кода на двата
// екрана и оттам нататък телефонът остава свързан към профила. После всяка
// снимка, направена на него, се появява тук сама.
const Phone = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  // На всеки две секунди, но САМО докато разделът "Учител" се гледа. Приложението
  // няма нужда да буди заспалия Render, докато никой не чака снимка — а и
  // безплатният план е за споделяне с приятели, не за постоянно бъбрене.
  const POLL_MS = 2000;

  let timer = null;
  let paired = [];            // свързаните устройства, както ги знае сървърът
  let pairing = null;         // { url, confirm_code, expires_at } докато QR кодът се вижда
  let expiryTimer = null;
  let queue = [];             // пристигнали снимки, които чакат скенера да се освободи
  let viewing = false;        // на раздела "Учител" ли сме
  // Знае ли сървърът отсреща изобщо за свързани телефони. Приложението се
  // раздава като инсталатор, а бекендът се качва отделно — между двете има
  // часове, в които новият екран говори със стар сървър. Тогава копчето не
  // бива да стои и да гърми: функцията просто я няма още.
  let supported = true;

  function loggedIn() {
    return !!(window.Auth && Auth.isLoggedIn());
  }

  // Кой раздел се вижда точно сега. Четем го от страницата, вместо да чакаме
  // събитието climby:view-shown: то се обажда чак при натискане на връзка в
  // менюто, а приложението СТАРТИРА на "Учител". Без това питането за снимки не
  // тръгваше изобщо, докато човекът не отидеше някъде другаде и не се върнеше.
  function tutorIsShowing() {
    const shown = document.querySelector('.view:not(.hidden)');
    return !!shown && shown.id === 'view-tutor';
  }

  async function api(path, options = {}) {
    const token = Auth.getToken();
    const res = await Net.fetch(BACKEND + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('phone.errSession'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Показваме текста от сървъра само когато той е наш и е писан за човек:
      // 400 и 429 са нашите откази. Всичко друго идва от рамката и е на
      // английски ("Not Found") — суров чужд низ насред български екран.
      const ours = res.status === 400 || res.status === 429;
      const err = new Error(ours && typeof data.detail === 'string' ? data.detail : t('phone.errGeneric'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- показване ----------

  function render() {
    const panel = $('phonePanel');
    if (!panel) return;

    const canUse = loggedIn() && supported;
    panel.classList.toggle('hidden', !supported);
    $('phoneLoggedOut').classList.toggle('hidden', canUse);
    $('phoneConnected').classList.toggle('hidden', !canUse || !paired.length || !!pairing);
    $('phoneUnpaired').classList.toggle('hidden', !canUse || !!paired.length || !!pairing);
    $('phoneQr').classList.toggle('hidden', !pairing);

    if (paired.length) {
      $('phoneDeviceName').textContent = paired[0].name;
    }
    renderQueue();
  }

  function renderQueue() {
    const el = $('phoneQueue');
    if (!el) return;
    el.classList.toggle('hidden', queue.length === 0);
    if (queue.length) {
      el.textContent = queue.length === 1
        ? t('phone.queueOne')
        : t('phone.queueMany', { n: queue.length });
    }
  }

  function showError(message) {
    const el = $('phoneError');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearError() {
    $('phoneError').classList.add('hidden');
  }

  // ---------- свързване ----------

  async function startPairing() {
    clearError();
    try {
      pairing = await api('/devices/pair', { method: 'POST' });
    } catch (err) {
      if (err && err.status === 404) { supported = false; render(); return; }
      showError(err.message);
      return;
    }
    drawQr(_localised(pairing.url));
    $('phoneConfirmCode').textContent = pairing.confirm_code;
    watchExpiry();
    render();
    syncPolling();  // докато кодът се вижда, чакаме телефона от другата страна
    poll();  // веднага, за да не се чака до две секунди след потвърждаване
  }

  // Телефонът е част от същото приложение и трябва да говори на същия език.
  // Кодът е в пътя, езикът — в заявката: не е тайна и няма какво да издаде.
  function _localised(url) {
    const lang = window.I18n ? I18n.get() : 'bg';
    return url + (url.includes('?') ? '&' : '?') + 'lang=' + encodeURIComponent(lang);
  }

  function drawQr(url) {
    const box = $('phoneQrBox');
    box.textContent = '';
    if (!window.QRCode) {
      // Библиотеката се раздава заедно с приложението, така че това не се очаква —
      // но адресът е по-полезен на екрана, отколкото празен квадрат.
      const fallback = document.createElement('p');
      fallback.className = 'phone-qr-fallback';
      fallback.textContent = url;
      box.appendChild(fallback);
      return;
    }
    // Кодът се чете от телефон на една ръка разстояние; 208 пиксела стигат и на
    // най-скромния екран, без да заемат целия раздел.
    new QRCode(box, {
      text: url,
      width: 208,
      height: 208,
      // Монохромно, като всичко останало тук. Цветът в това приложение значи
      // "това е AI" и никъде другаде.
      colorDark: '#16161a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function watchExpiry() {
    clearInterval(expiryTimer);
    const tick = () => {
      if (!pairing) return clearInterval(expiryTimer);
      const left = Math.round((new Date(pairing.expires_at) - Date.now()) / 1000);
      if (left <= 0) {
        cancelPairing();
        showError(t('phone.expired'));
        return;
      }
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, '0');
      $('phoneExpiry').textContent = t('phone.expiresIn', { time: `${m}:${s}` });
    };
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  function cancelPairing() {
    pairing = null;
    clearInterval(expiryTimer);
    $('phoneQrBox').textContent = '';
    render();
    syncPolling();
  }

  async function refreshDevices() {
    if (!loggedIn()) {
      paired = [];
      render();
      return;
    }
    try {
      paired = await api('/devices');
      supported = true;
    } catch (err) {
      if (err && err.status === 404) supported = false;
      // Мълчим: списъкът е странична информация, а не работата на този раздел.
      // Заспал сървър не бива да слага червено съобщение върху скенера.
    }
    render();
  }

  async function forget(deviceId) {
    await api(`/devices/${deviceId}`, { method: 'DELETE' });
    await refreshDevices();
  }

  // ---------- прибиране на снимките ----------

  async function poll() {
    if (!loggedIn()) return;
    let photos;
    try {
      photos = await api('/devices/photos');
    } catch {
      return;  // заспал сървър или прекъсната мрежа — следващият опит е след две секунди
    }
    if (!photos.length) return;

    // Първата пристигнала снимка значи, че телефонът е потвърден от другата
    // страна: QR кодът вече не трябва на никого.
    if (pairing) {
      cancelPairing();
      // Изчакваме списъка, преди да преценим дали да продължим да питаме:
      // cancelPairing вече е нулирал поканата, а устройството още не е в списъка,
      // така че решение точно сега значи "няма за какво да питам" — и питането
      // спира завинаги, веднага след първата пристигнала снимка.
      refreshDevices().then(syncPolling);
    }
    for (const photo of photos) {
      queue.push(`data:${photo.media_type};base64,${photo.data}`);
    }
    renderQueue();
    drain();
  }

  // Скенерът кадрира една страница наведнъж. Ако пристигнат две, втората изчаква
  // реда си, вместо да изхвърли първата изпод ръцете на човека.
  function drain() {
    if (!queue.length || !window.Scanner || !Scanner.isIdle()) return;
    const dataUrl = queue.shift();
    renderQueue();
    // Само ако наистина сме другаде: излишното превключване вдига
    // climby:view-shown и с това още едно ненужно питане към сървъра.
    if (!tutorIsShowing()) Nav.activate('tutor');
    Scanner.acceptPhoto(dataUrl);
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.hidden) return;   // скрит раздел не чака снимка
      poll();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(timer);
    timer = null;
  }

  // Питаме само когато има смисъл: гледаме раздела "Учител" и или има свързан
  // телефон, или точно сега се свързва.
  function syncPolling() {
    if (viewing && loggedIn() && supported && (paired.length || pairing)) startPolling();
    else stopPolling();
  }

  // ---------- начало ----------

  function init() {
    if (!$('phonePanel')) return;

    $('phonePairBtn').addEventListener('click', startPairing);
    $('phoneQrCancelBtn').addEventListener('click', () => { clearError(); cancelPairing(); });
    $('phoneRepairBtn').addEventListener('click', startPairing);

    window.addEventListener('climby:view-shown', e => {
      viewing = e.detail.view === 'tutor';
      if (viewing) {
        refreshDevices().then(syncPolling);
      } else {
        // Незавършено свързване не бива да живее зад гърба на човека: QR кодът е
        // ключ и си отива заедно с екрана, на който се вижда.
        if (pairing) cancelPairing();
        syncPolling();
      }
    });

    window.addEventListener('climby:auth-changed', () => {
      queue = [];
      if (pairing) cancelPairing();
      refreshDevices().then(syncPolling);
    });

    // Скенерът се освободи — ако нещо чака, влиза сега.
    window.addEventListener('climby:scanner-idle', drain);
    window.addEventListener('climby:lang-changed', render);
    window.addEventListener('pagehide', stopPolling);

    viewing = tutorIsShowing();
    refreshDevices().then(syncPolling);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { forget, refreshDevices, listPaired: () => paired.slice() };
})();

window.Phone = Phone;
