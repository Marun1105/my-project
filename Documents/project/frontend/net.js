// net.js — обвивка около fetch, която понася "събуждането" на безплатния Render сървър.
//
// Безплатният план приспива сървъра след около 15 минути без заявки. Първата заявка
// след това често не стига до приложението изобщо: ръбът на Render връща 502/503/504
// или връзката пада. За ученика това изглежда като "няма интернет", въпреки че всичко
// е наред — сървърът просто става от сън. Затова изчакваме да се събуди и повтаряме.
//
// Кога е безопасно да повторим заявката (важно за POST — не искаме два акаунта или
// две еднакви задачи):
//   • 502/503/504 — това е отговор от ръба на Render, приложението изобщо не е видяло
//     заявката. Повтарянето е безопасно при всеки метод.
//   • Мрежова грешка — не знаем дали заявката е стигнала. Затова първо питаме
//     здравната проверка (GET /). Ако тя отговори веднага, сървърът е бил буден и
//     грешката е друга — тогава НЕ повтаряме, за да не дублираме нещо, което може
//     вече да е записано. Ако и тя не отговаря, сървърът наистина спи и заявката
//     не е стигнала доникъде — изчакваме и повтаряме.
const Net = (() => {
  const BACKEND = window.CLIMBY_BACKEND;

  const COLD_START_STATUSES = [502, 503, 504];
  const PROBE_EVERY_MS = 3000;
  const WAKE_BUDGET_MS = 60000; // Render обикновено се вдига за 30-50 секунди

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Здравната проверка е GET и нищо не променя — може да се вика колкото трябва.
  async function _isAwake() {
    try {
      const res = await fetch(BACKEND + '/', { method: 'GET', cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Чака сървъра да се вдигне. Връща true, ако е отговорил в рамките на бюджета.
  async function _waitForWake() {
    _showBanner();
    const deadline = Date.now() + WAKE_BUDGET_MS;
    try {
      while (Date.now() < deadline) {
        await sleep(PROBE_EVERY_MS);
        if (await _isAwake()) return true;
      }
      return false;
    } finally {
      _hideBanner();
    }
  }

  let _banner = null;

  function _showBanner() {
    if (!_banner) {
      _banner = document.createElement('div');
      _banner.className = 'wake-banner';
      _banner.setAttribute('role', 'status');
      document.body.appendChild(_banner);
    }
    _banner.textContent = window.t ? window.t('net.waking') : 'Сървърът се събужда…';
    _banner.classList.remove('hidden');
  }

  function _hideBanner() {
    if (_banner) _banner.classList.add('hidden');
  }

  // Същият подпис като fetch — заместваме го на място в останалите модули.
  async function request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      // Мрежова грешка: повтаряме само ако сървърът наистина е бил долу.
      if (await _isAwake()) throw err;
      if (!(await _waitForWake())) throw err;
      return fetch(url, options);
    }

    if (COLD_START_STATUSES.includes(res.status)) {
      // Приложението не е видяло заявката — безопасно е да я пратим пак.
      if (await _waitForWake()) return fetch(url, options);
    }
    return res;
  }

  return { fetch: request };
})();
