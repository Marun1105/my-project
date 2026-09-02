// sw.js — service worker: прави приложението инсталируемо и позволява да се отвори без интернет.
// Стратегия: сървърът е винаги пръв за данни (нищо от API-то не се кешира). Първи е и
// за кода на приложението — HTML, CSS, JS и manifest се теглят от мрежата, а кешът е
// само мрежата за сигурност, когато връзката я няма.
//
// Защо: страницата се теглеше от мрежата, но скриптовете идваха от кеша. След деплой
// това дава нов HTML, който върви със стар JS — новите ключове за преводи например
// излизат като сурови имена на екрана, докато човекът не отвори приложението втори път.
// Вдигането на номера по-долу не помага за същото това отваряне: новият service worker
// поема чак след като страницата вече си е изтеглила скриптовете.
//
// Шрифтовете и иконите остават на кеша — те не се променят, без да им се смени името.
// Номерът се вдига, когато старият кеш трябва да отпадне изцяло (сменен шрифт, махнат файл).
const CACHE = 'climby-shell-v11';

// Файлове, чието съдържание не се променя под същото име. Само за тях кешът изпреварва
// мрежата; всичко останало от нашия произход тръгва по мрежата.
const IMMUTABLE = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico)$/i;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './i18n.js',
  './net.js',
  './classes.js',
  './subjects.js',
  './subjects.css',
  './classes.css',
  './fonts.css',
  './fonts/inter-cyrillic-ext-wght-normal.woff2',
  './fonts/inter-cyrillic-wght-normal.woff2',
  './fonts/inter-latin-ext-wght-normal.woff2',
  './fonts/inter-latin-wght-normal.woff2',
  './fonts/space-grotesk-latin-ext-wght-normal.woff2',
  './fonts/space-grotesk-latin-wght-normal.woff2',
  './theme.js',
  './settings.js',
  './nav.js',
  './scanner.js',
  './phone.js',
  './vendor/qrcode.min.js',
  './tutor.js',
  './auth.js',
  './checklist.js',
  './ai-planner.js',
  './history.js',
  './focus.js',
  './family.js',
  './onboarding.js',
  // marked и DOMPurify стоят при нас, а не на CDN — в кеша са, за да работи AI
  // отговорът и когато мрежата я няма.
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './manifest.json',
  './logo.png',
  './logo-icon.png',
  './logo-favicon.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll се проваля изцяло, ако един файл липсва — добавяме поединично, за да
      // не счупим инсталацията заради една липсваща икона
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function offlineResponse() {
  return new Response(
    '<meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Climby е офлайн. Включи интернет и опитай пак.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Само нашите собствени файлове се кешират — заявките към бекенда и към CDN-ите
  // (opencv, face-api, katex) минават директно по мрежата.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(cached => {
      // Шрифт или икона от кеша тръгва веднага — съдържанието им не се променя,
      // а те са и най-тежките файлове в обвивката.
      if (cached && IMMUTABLE.test(url.pathname)) return cached;

      // Страницата и кодът ѝ се теглят заедно от мрежата, за да си пасват.
      return fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          } else if (cached) {
            // Сървърът отговори, но с грешка. Кешираното копие върши повече работа
            // от празен екран, а и обикновено е точно това, което е работило досега.
            return cached;
          }
          // respondWith иска Response: ако файлът липсва и в кеша (cache.add при
          // инсталацията може тихо да се е провалил), вместо приложението излиза
          // сивата страница за мрежова грешка на браузъра.
          return res || offlineResponse();
        })
        // Тук сме офлайн: кешът е причината този service worker изобщо да съществува.
        .catch(() => cached || offlineResponse());
    })
  );
});
