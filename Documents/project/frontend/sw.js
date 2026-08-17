// sw.js — service worker: прави приложението инсталируемо и позволява да се отвори без интернет.
// Стратегия: сървърът е винаги пръв за данни (нищо от API-то не се кешира), а самата
// обвивка на приложението (HTML/CSS/JS/икони) се кешира, за да тръгва мигновено.
const CACHE = 'climby-shell-v4';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './i18n.js',
  './net.js',
  './theme.js',
  './settings.js',
  './nav.js',
  './scanner.js',
  './tutor.js',
  './auth.js',
  './checklist.js',
  './ai-planner.js',
  './history.js',
  './focus.js',
  './family.js',
  './onboarding.js',
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Само нашите собствени файлове се кешират — заявките към бекенда и към CDN-ите
  // (opencv, face-api, katex) минават директно по мрежата.
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/';

  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);

      // За самата страница пробваме първо мрежата: иначе нов деплой се вижда чак
      // при второто отваряне, което изглежда като "промените ги няма".
      // За останалото кешът тръгва веднага (бърз старт) и се обновява отзад.
      if (isPage) return network;
      return cached || network;
    })
  );
});
